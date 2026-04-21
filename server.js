const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const HTML_PATH = path.join(__dirname, "AdaptaEval_HCA_v2.html");

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendHtml(res) {
  fs.readFile(HTML_PATH, "utf8", (error, content) => {
    if (error) {
      sendJson(res, 500, { error: "No se pudo cargar la interfaz HTML." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("La solicitud es demasiado grande."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function cleanText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPrompt(payload) {
  const supports = Array.isArray(payload.supports) && payload.supports.length
    ? payload.supports.map((item) => `- ${item}`).join("\n")
    : "- Usa adecuaciones razonables según el perfil del estudiante.";

  return cleanText(`
Eres un especialista en educación diferencial chilena, evaluación inclusiva y adecuaciones curriculares. Trabajas para el Instituto Hans Christian Andersen.

Tu tarea es transformar una prueba escolar real en una versión adaptada útil para un docente chileno.

Marco obligatorio:
- Considera Decreto 83/2015, Decreto 67/2018 y Decreto 170/2009.
- Mantén el aprendizaje esencial y la intención evaluativa.
- No inventes contenidos ajenos a la prueba.
- No des recomendaciones generales sin concretar cambios.
- Debes entregar una prueba adaptada completa y usable.
- Si la prueba original trae preguntas enumeradas, conserva esa numeración cuando sea útil.
- Prioriza lenguaje claro, instrucciones paso a paso, formato accesible y ajustes proporcionales al perfil del estudiante.

Responde usando exactamente estos bloques y en este orden. No uses markdown adicional fuera de ellos:

===PRUEBA_ADAPTADA===
[escribe aquí la prueba adaptada completa]
===FIN_PRUEBA_ADAPTADA===

===RESUMEN_CAMBIOS===
- Cambio 1: ...
- Cambio 2: ...
- Cambio 3: ...
===FIN_RESUMEN_CAMBIOS===

===JUSTIFICACION_DOCENTE===
CAMBIO: ...
JUSTIFICACION: ...
DECRETO: ...
OPTIMIZACION: ...
---
CAMBIO: ...
JUSTIFICACION: ...
DECRETO: ...
OPTIMIZACION: ...
---
NOTA_LEGAL: ...
===FIN_JUSTIFICACION_DOCENTE===

No uses placeholders, no escribas nada fuera de esos bloques y no expliques tu proceso.
Si no puedes completar algún bloque, igual escribe contenido útil dentro del bloque correspondiente y nunca lo dejes vacío.

Datos del caso:
Asignatura: ${cleanText(payload.subject) || "No informada"}
Curso: ${cleanText(payload.course) || "No informado"}
Objetivo de aprendizaje:
${cleanText(payload.learningGoal) || "No informado"}

Perfil del estudiante / NEE:
${cleanText(payload.studentProfile)}

Ajustes que el docente desea privilegiar:
${supports}

Observación docente:
${cleanText(payload.teacherNote) || "Sin observación adicional."}

Prueba original completa:
${cleanText(payload.evaluationText)}
  `);
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error("Falta configurar GEMINI_API_KEY en el servidor.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096
      }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorText = data?.error?.message || `Gemini devolvió HTTP ${response.status}`;
    throw new Error(errorText);
  }

  const text = (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || "")
    .join("\n");

  return cleanText(text);
}

async function reformatGeminiResponse(originalPrompt, rawResponse) {
  const repairPrompt = cleanText(`
Necesito que reformatees y completes una respuesta previa para que quede usable por un docente.

Objetivo:
- Si la respuesta previa ya contiene una prueba adaptada, reorganízala.
- Si la respuesta previa solo contiene resumen de cambios y justificación, reconstruye una prueba adaptada coherente usando el contexto del encargo original.
- No escribas explicaciones meta.

Debes responder usando exactamente estos bloques:

===PRUEBA_ADAPTADA===
[prueba adaptada completa]
===FIN_PRUEBA_ADAPTADA===

===RESUMEN_CAMBIOS===
- Cambio 1: ...
- Cambio 2: ...
- Cambio 3: ...
===FIN_RESUMEN_CAMBIOS===

===JUSTIFICACION_DOCENTE===
CAMBIO: ...
JUSTIFICACION: ...
DECRETO: ...
OPTIMIZACION: ...
---
NOTA_LEGAL: ...
===FIN_JUSTIFICACION_DOCENTE===

Encargo original:
${originalPrompt}

Respuesta previa a reparar:
${rawResponse}
  `);

  return callGemini(repairPrompt);
}

async function generateAdaptedOnly(payload, rawResponse) {
  const supports = Array.isArray(payload.supports) && payload.supports.length
    ? payload.supports.map((item) => `- ${item}`).join("\n")
    : "- Usa adecuaciones razonables según el perfil del estudiante.";

  const prompt = cleanText(`
Necesito solo la prueba adaptada completa, sin explicaciones ni texto adicional.

Contexto:
- Asignatura: ${cleanText(payload.subject) || "No informada"}
- Curso: ${cleanText(payload.course) || "No informado"}
- Objetivo de aprendizaje:
${cleanText(payload.learningGoal) || "No informado"}

- Perfil del estudiante / NEE:
${cleanText(payload.studentProfile)}

- Ajustes que se deben privilegiar:
${supports}

- Observación docente:
${cleanText(payload.teacherNote) || "Sin observación adicional."}

Prueba original:
${cleanText(payload.evaluationText)}

Si te ayuda, esta fue una respuesta previa incompleta:
${cleanText(rawResponse)}

Tarea:
- Reescribe la prueba completa en versión adaptada.
- Conserva el foco evaluativo.
- Ajusta lenguaje, instrucciones, cantidad de apoyo y formato de respuesta según el perfil del estudiante.
- No expliques los cambios.
- No escribas resumen ni justificación.

Responde solamente con el texto final de la prueba adaptada.
  `);

  return callGemini(prompt);
}

async function verifyGeminiKey() {
  if (!GEMINI_API_KEY) {
    throw new Error("Falta configurar GEMINI_API_KEY en el archivo .env.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: "Responde solo con OK" }
          ]
        }
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8
      }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorText = data?.error?.message || `Gemini devolvió HTTP ${response.status}`;
    throw new Error(errorText);
  }

  return true;
}

function extractSection(source, startMarker, endMarker) {
  const text = cleanText(source);
  const startIndex = text.indexOf(startMarker);
  const endIndex = text.indexOf(endMarker);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    return cleanText(text.slice(startIndex + startMarker.length, endIndex));
  }
  return "";
}

function isPlaceholderContent(text) {
  const normalized = cleanText(text).toLowerCase();
  if (!normalized) return true;
  if (normalized.length > 180) return false;
  return [
    /^\.\.\.$/,
    /^\[.*contenido.*\]$/,
    /^\[.*aqui va.*\]$/,
    /^\[.*placeholder.*\]$/,
    /\baqui va\b/,
    /\bplaceholder\b/,
    /\bpendiente\b/,
    /\btbd\b/,
    /^no se recibi[oó].*v[aá]lida\.?$/
  ].some((pattern) => pattern.test(normalized));
}

function fallbackSection(text, kind) {
  const raw = cleanText(text);
  const upper = raw.toUpperCase();

  if (kind === "adapted") {
    if (!upper.includes("===RESUMEN_CAMBIOS===") && !upper.includes("===JUSTIFICACION_DOCENTE===")) {
      return raw;
    }

    const summaryIndex = upper.indexOf("===RESUMEN_CAMBIOS===");
    const teacherIndex = upper.indexOf("===JUSTIFICACION_DOCENTE===");
    const candidates = [summaryIndex, teacherIndex].filter((index) => index !== -1);
    if (candidates.length) {
      return cleanText(raw.slice(0, Math.min(...candidates)));
    }
  }

  if (kind === "summary") {
    const start = upper.indexOf("===RESUMEN_CAMBIOS===");
    if (start !== -1) {
      const rest = raw.slice(start + "===RESUMEN_CAMBIOS===".length);
      const end = rest.toUpperCase().indexOf("===JUSTIFICACION_DOCENTE===");
      return cleanText(end !== -1 ? rest.slice(0, end) : rest);
    }

    const teacherIndex = upper.indexOf("===JUSTIFICACION_DOCENTE===");
    if (teacherIndex !== -1) {
      const beforeTeacher = cleanText(raw.slice(0, teacherIndex));
      const lines = beforeTeacher.split("\n").map((line) => cleanText(line)).filter(Boolean);
      const bulletish = lines.filter((line) => /^[-*•\d]/.test(line));
      return cleanText((bulletish.length ? bulletish : lines.slice(-5)).join("\n"));
    }
  }

  if (kind === "teacher") {
    const start = upper.indexOf("===JUSTIFICACION_DOCENTE===");
    if (start !== -1) {
      return cleanText(raw.slice(start + "===JUSTIFICACION_DOCENTE===".length));
    }
    if (upper.includes("CAMBIO:") || upper.includes("JUSTIFICACION:")) {
      const matchIndex = raw.search(/CAMBIO:|JUSTIFICACION:/i);
      return cleanText(raw.slice(matchIndex));
    }
  }

  return raw;
}

function looksLikeAdaptedAssessment(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return false;
  const lines = cleaned.split("\n").filter(Boolean);
  const questionSignals = (cleaned.match(/\b\d+[\)\.\-]/g) || []).length;
  const itemSignals = (cleaned.match(/\b(A|B|C|D)[\)\.\-:]/g) || []).length;
  return lines.length >= 4 && (questionSignals >= 1 || itemSignals >= 2 || cleaned.length > 280);
}

function parseTeacherTable(rawText) {
  const text = cleanText(rawText);
  const noteMatch = text.match(/NOTA_LEGAL\s*:\s*([\s\S]*)$/i);
  const note = noteMatch ? cleanText(noteMatch[1]) : "";
  const body = noteMatch ? cleanText(text.slice(0, noteMatch.index)) : text;
  const blocks = body.split(/\n?\s*---\s*\n?/).map((item) => cleanText(item)).filter(Boolean);

  const rows = blocks.map((block) => {
    const row = { cambio: "", justificacion: "", decreto: "", optimizacion: "" };
    let current = "";
    block.split("\n").forEach((line) => {
      const match = line.match(/^(CAMBIO|JUSTIFICACION|DECRETO|OPTIMIZACION)\s*:\s*(.*)$/i);
      if (match) {
        current = match[1].toUpperCase();
        const value = cleanText(match[2]);
        if (current === "CAMBIO") row.cambio = value;
        if (current === "JUSTIFICACION") row.justificacion = value;
        if (current === "DECRETO") row.decreto = value;
        if (current === "OPTIMIZACION") row.optimizacion = value;
      } else if (current) {
        const key = current === "CAMBIO" ? "cambio" : current === "JUSTIFICACION" ? "justificacion" : current === "DECRETO" ? "decreto" : "optimizacion";
        row[key] = cleanText(`${row[key]}\n${line}`);
      }
    });
    return row;
  }).filter((row) => row.cambio || row.justificacion || row.decreto || row.optimizacion);

  return { rows, note };
}

function parseGeminiResponse(rawText) {
  const warnings = [];
  let adapted = extractSection(rawText, "===PRUEBA_ADAPTADA===", "===FIN_PRUEBA_ADAPTADA===") || fallbackSection(rawText, "adapted");
  const summary = extractSection(rawText, "===RESUMEN_CAMBIOS===", "===FIN_RESUMEN_CAMBIOS===") || fallbackSection(rawText, "summary");
  const teacher = extractSection(rawText, "===JUSTIFICACION_DOCENTE===", "===FIN_JUSTIFICACION_DOCENTE===") || fallbackSection(rawText, "teacher");

  if (!looksLikeAdaptedAssessment(adapted) && looksLikeAdaptedAssessment(rawText)) {
    adapted = rawText;
    warnings.push("Gemini no respetó los marcadores, así que se rescató la respuesta completa como prueba adaptada.");
  }

  if (isPlaceholderContent(adapted)) warnings.push("La prueba adaptada vino vacía o con texto de ejemplo.");
  if (isPlaceholderContent(summary)) warnings.push("El resumen de cambios vino vacío o con texto de ejemplo.");
  if (isPlaceholderContent(teacher)) warnings.push("La justificación docente vino vacía o con texto de ejemplo.");

  const teacherTable = parseTeacherTable(teacher);

  return {
    adapted: isPlaceholderContent(adapted) ? "No se recibió una prueba adaptada válida." : adapted,
    summary: isPlaceholderContent(summary) ? "No se recibió un resumen de cambios válido." : summary,
    teacher: isPlaceholderContent(teacher) ? "No se recibió una justificación docente válida." : teacher,
    teacher_rows: teacherTable.rows,
    teacher_note: teacherTable.note,
    warnings
  };
}

function mergeAdaptedIntoParsed(parsed, adaptedText) {
  const cleaned = cleanText(adaptedText);
  if (cleaned && !isPlaceholderContent(cleaned)) {
    parsed.adapted = adaptedText;
    parsed.warnings = parsed.warnings.filter((item) => !item.includes("La prueba adaptada vino vacía"));
    if (!parsed.warnings.includes("La prueba adaptada se reconstruyó con una solicitud adicional automática.")) {
      parsed.warnings.unshift("La prueba adaptada se reconstruyó con una solicitud adicional automática.");
    }
  }
  return parsed;
}

function validatePayload(payload) {
  if (!cleanText(payload.studentProfile)) {
    return "Falta el perfil del estudiante o las NEE.";
  }
  if (!cleanText(payload.evaluationText)) {
    return "Falta la prueba original.";
  }
  return "";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    sendHtml(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    try {
      await verifyGeminiKey();
      sendJson(res, 200, {
        ok: true,
        model: GEMINI_MODEL,
        configured: Boolean(GEMINI_API_KEY)
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        model: GEMINI_MODEL,
        configured: Boolean(GEMINI_API_KEY),
        error: error.message || "No se pudo validar la clave de Gemini."
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/adapt") {
    try {
      const rawBody = await readRequestBody(req);
      const payload = JSON.parse(rawBody || "{}");
      const validationError = validatePayload(payload);
      if (validationError) {
        sendJson(res, 400, { error: validationError });
        return;
      }

      const prompt = buildPrompt(payload);
      let rawResponse = await callGemini(prompt);
      let parsed = parseGeminiResponse(rawResponse);

      const needsRepair =
        parsed.adapted === "No se recibió una prueba adaptada válida." &&
        (parsed.summary !== "No se recibió un resumen de cambios válido." ||
          parsed.teacher !== "No se recibió una justificación docente válida.");

      if (needsRepair) {
        rawResponse = await reformatGeminiResponse(prompt, rawResponse);
        parsed = parseGeminiResponse(rawResponse);
        if (!parsed.warnings.includes("La primera respuesta de Gemini venía incompleta y se intentó reparar automáticamente.")) {
          parsed.warnings.unshift("La primera respuesta de Gemini venía incompleta y se intentó reparar automáticamente.");
        }
      }

      if (parsed.adapted === "No se recibió una prueba adaptada válida.") {
        const adaptedOnly = await generateAdaptedOnly(payload, rawResponse);
        parsed = mergeAdaptedIntoParsed(parsed, adaptedOnly);
        if (parsed.adapted === "No se recibió una prueba adaptada válida.") {
          const cleanedFallback = cleanText(adaptedOnly);
          if (cleanedFallback.length > 120) {
            parsed.adapted = cleanedFallback;
            parsed.warnings = parsed.warnings.filter((item) => !item.includes("La prueba adaptada vino vacía"));
            parsed.warnings.unshift("La prueba adaptada se rescató desde una respuesta libre de Gemini.");
          }
        }
      }

      sendJson(res, 200, parsed);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Error inesperado al generar la adaptación." });
    }
    return;
  }

  sendJson(res, 404, { error: "Ruta no encontrada." });
});

server.listen(PORT, () => {
  console.log(`AdaptaEval disponible en http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) {
    console.log("Advertencia: falta GEMINI_API_KEY. Crea un archivo .env basado en .env.example.");
  }
});
