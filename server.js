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
const ANOTACIONES_HTML_PATH = path.join(__dirname, "Anotaciones_RICE_HCA.html");
const DEFAULT_RICE_PATH = path.join(__dirname, "RICE2025_ACTUALIZADO.pdf");
const DEFAULT_RICE_TEXT_PATH = path.join(__dirname, "RICE2025_ACTUALIZADO.txt");
let defaultRiceTextCache = "";

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendHtml(res, htmlPath = HTML_PATH) {
  fs.readFile(htmlPath, "utf8", (error, content) => {
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
      if (body.length > 15_000_000) {
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

function normalizeSupportText(value) {
  return cleanText(value).toLowerCase();
}

function estimateItemCount(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return 0;

  const lines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  const matches = lines.filter((line) => (
    /^\d+\s*[\)\.\-:]/.test(line) ||
    /^item\s+\d+/i.test(line) ||
    /^pregunta\s+\d+/i.test(line)
  ));

  return matches.length;
}

function hasExcessiveReduction(originalText, adaptedText) {
  const originalCount = estimateItemCount(originalText);
  const adaptedCount = estimateItemCount(adaptedText);

  if (originalCount < 3 || adaptedCount === 0) return false;
  if (originalCount >= 5 && adaptedCount <= 1) return true;

  let minimumAllowed = Math.max(2, originalCount - 1);
  if (originalCount >= 5) minimumAllowed = Math.max(3, originalCount - 2);
  if (originalCount >= 8) minimumAllowed = Math.max(minimumAllowed, Math.ceil(originalCount * 0.6));

  return adaptedCount < minimumAllowed;
}

function extractQuestionNumbers(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return [];

  const numbers = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s*[\)\.\-:]/);
      return match ? Number(match[1]) : null;
    })
    .filter((value) => Number.isInteger(value));

  return Array.from(new Set(numbers)).sort((a, b) => a - b);
}

function highestQuestionNumber(text) {
  const numbers = extractQuestionNumbers(text);
  return numbers.length ? numbers[numbers.length - 1] : 0;
}

function declaresHundredPoints(text) {
  const cleaned = cleanText(text).toLowerCase();
  return /puntaje\s+total\s*:\s*100\b/.test(cleaned) || /total\s*:\s*100\s*puntos\b/.test(cleaned);
}

function needsStructuralRebuild(originalText, adaptedText) {
  const reasons = [];
  const cleanedAdapted = cleanText(adaptedText);
  if (!cleanedAdapted) return ["La prueba adaptada quedÃ³ vacÃ­a."];

  if (hasExcessiveReduction(originalText, cleanedAdapted)) {
    reasons.push("La adaptaciÃ³n redujo demasiado la cantidad de preguntas.");
  }

  const originalHighest = highestQuestionNumber(originalText);
  const adaptedHighest = highestQuestionNumber(cleanedAdapted);
  if (originalHighest >= 4 && adaptedHighest > 0 && adaptedHighest < originalHighest) {
    reasons.push("La adaptaciÃ³n no conservÃ³ la cobertura completa o casi completa de la numeraciÃ³n original.");
  }

  if (!declaresHundredPoints(cleanedAdapted)) {
    reasons.push("La adaptaciÃ³n no declara puntaje total de 100 puntos.");
  }

  return reasons;
}

function buildPrompt(payload) {
  const supports = Array.isArray(payload.supports) && payload.supports.length
    ? payload.supports.map((item) => `- ${item}`).join("\n")
    : "- Usa adecuaciones razonables segÃºn el perfil del estudiante.";

  return cleanText(`
Eres un especialista en educaciÃ³n diferencial chilena, evaluaciÃ³n inclusiva y adecuaciones curriculares. Trabajas para el Instituto Hans Christian Andersen.

Tu tarea es transformar una prueba escolar real en una versiÃ³n adaptada Ãºtil para un docente chileno.

Marco obligatorio:
- Considera Decreto 83/2015, Decreto 67/2018 y Decreto 170/2009.
- MantÃ©n el aprendizaje esencial y la intenciÃ³n evaluativa.
- No inventes contenidos ajenos a la prueba.
- No des recomendaciones generales sin concretar cambios.
- Debes entregar una prueba adaptada completa y usable.
- Si la prueba original trae preguntas enumeradas, conserva esa numeraciÃ³n cuando sea Ãºtil.
- Prioriza lenguaje claro, instrucciones paso a paso, formato accesible y ajustes proporcionales al perfil del estudiante.

Responde usando exactamente estos bloques y en este orden. No uses markdown adicional fuera de ellos:

===PRUEBA_ADAPTADA===
[escribe aquÃ­ la prueba adaptada completa]
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
Si no puedes completar algÃºn bloque, igual escribe contenido Ãºtil dentro del bloque correspondiente y nunca lo dejes vacÃ­o.

Datos del caso:
Asignatura: ${cleanText(payload.subject) || "No informada"}
Curso: ${cleanText(payload.course) || "No informado"}
Objetivo de aprendizaje:
${cleanText(payload.learningGoal) || "No informado"}

Perfil del estudiante / NEE:
${cleanText(payload.studentProfile)}

Ajustes que el docente desea privilegiar:
${supports}

ObservaciÃ³n docente:
${cleanText(payload.teacherNote) || "Sin observaciÃ³n adicional."}

Prueba original completa:
${cleanText(payload.evaluationText)}
  `);
}

function buildPromptStrict(payload) {
  const supports = Array.isArray(payload.supports) && payload.supports.length
    ? payload.supports.map((item) => `- ${item}`).join("\n")
    : "- Usa adecuaciones razonables segun el perfil del estudiante.";

  return cleanText(`
Eres un especialista en educacion diferencial chilena, evaluacion inclusiva y adecuaciones curriculares. Trabajas para el Instituto Hans Christian Andersen.

Tu tarea es transformar una prueba escolar real en una version adaptada util para un docente chileno.

Marco obligatorio:
- Considera Decreto 83/2015, Decreto 67/2018 y Decreto 170/2009.
- Manten el aprendizaje esencial y la intencion evaluativa.
- No inventes contenidos ajenos a la prueba.
- No des recomendaciones generales sin concretar cambios.
- Debes entregar una prueba adaptada completa y usable.
- La evaluacion adaptada final debe quedar en puntaje total de 100 puntos.
- Si la prueba original trae otro puntaje, redistribuye los puntajes para que la version adaptada sume exactamente 100 puntos.
- Debes escribir de forma visible "Puntaje total: 100 puntos" o equivalente directo dentro de la prueba adaptada.
- Conserva la estructura general de la evaluacion original.
- Conserva secciones, secuencia, numeracion y casi todos los items.
- Mantiene el mismo orden de secciones, preguntas, subitems y alternativas de la prueba original siempre que sea posible.
- Respeta la numeracion original. Si necesitas renumerar, hazlo de forma correlativa, limpia y sin saltos desordenados.
- Mantiene un formato lo mas parecido posible al original: encabezados, bloques, alternativas, puntajes y espacios de respuesta.
- No cambies signos, operaciones, datos numericos, alternativas correctas ni contenido matematico de la prueba original, salvo que el cambio sea solo de redaccion o apoyo para hacerla mas accesible.
- Si una pregunta original usa suma, resta, multiplicacion o division, la adaptacion debe mantener esa misma operacion.
- Si la prueba original tiene 10 preguntas o menos, conserva todas las preguntas. Solo simplifica redaccion, formato, apoyos e instrucciones.
- Si el docente pide reducir cantidad de items, haz una reduccion moderada, no extrema.
- Nunca transformes una evaluacion de varias preguntas en una sola pregunta o en un solo ejercicio.
- Si la prueba original tiene 5 o mas items o preguntas, la version adaptada debe mantener al menos 3 y normalmente 60% o mas de los items.
- No elimines secciones completas salvo que sean claramente redundantes y puedas fusionarlas sin perder evidencia evaluativa.
- No dejes la prueba a medias. La respuesta debe terminar con la ultima pregunta o ultimo subitem correspondiente a la prueba original.
- Antes de cerrar, verifica internamente que la prueba adaptada este completa, que conserve la cobertura de preguntas y que el puntaje total declarado sea 100 puntos.
- Prioriza lenguaje claro, instrucciones paso a paso, formato accesible y ajustes proporcionales al perfil del estudiante.

Responde usando exactamente estos bloques y en este orden. No uses markdown adicional fuera de ellos:

===PRUEBA_ADAPTADA===
[escribe aqui la prueba adaptada completa]
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
Si no puedes completar algun bloque, igual escribe contenido util dentro del bloque correspondiente y nunca lo dejes vacio.

Datos del caso:
Asignatura: ${cleanText(payload.subject) || "No informada"}
Curso: ${cleanText(payload.course) || "No informado"}
Objetivo de aprendizaje:
${cleanText(payload.learningGoal) || "No informado"}

Perfil del estudiante / NEE:
${cleanText(payload.studentProfile)}

Ajustes que el docente desea privilegiar:
${supports}

Observacion docente:
${cleanText(payload.teacherNote) || "Sin observacion adicional."}

Prueba original completa:
${cleanText(payload.evaluationText)}
  `);
}

async function callGemini(prompt) {
  return callGeminiParts([{ text: prompt }], {
    temperature: 0.2,
    maxOutputTokens: 4096
  });
}

async function callGeminiParts(parts, generationConfig = {}) {
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
          parts
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        ...generationConfig
      }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorText = data?.error?.message || `Gemini devolviÃ³ HTTP ${response.status}`;
    throw new Error(errorText);
  }

  const text = (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || "")
    .join("\n");

  return cleanText(text);
}

function parseJsonObject(rawText) {
  const cleaned = cleanText(rawText).replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw error;
  }
}

function buildAnotacionPrompt(payload) {
  const reglamento = cleanText(payload.reglamento) || getDefaultRiceContext(payload);
  const categorias = Array.isArray(payload.categorias) && payload.categorias.length
    ? payload.categorias.map((item) => cleanText(item)).filter(Boolean)
    : [
        "Conducta Inadecuada dentro del establecimiento",
        "Conducta Inadecuada dentro de la sala de clases",
        "Conducta Inadecuada con miembros de la comunidad educativa",
        "Incumplimiento de responsabilidades",
        "Uso indebido de dispositivo movil de comunicacion",
        "Felicitaciones",
        "Agradecimiento",
        "Constancia (Observacion)",
        "Inasistencia a Evaluaciones",
        "Inasistencia a entrevista de apoderados",
        "Inasistencia a reunion de apoderados",
        "Desregulacion emocional",
        "Conversacion con estudiante",
        "Atencion Enfermeria"
      ];

  return cleanText(`
Eres un especialista chileno en convivencia escolar, libro de clases y aplicacion de RICE/reglamento interno.

Objetivo:
Transforma el relato del docente en un registro escolar objetivo, profesional y usable.

Reglas obligatorias:
- Redacta sin juicios de valor, sin diagnosticar intenciones y sin adjetivos descalificadores.
- Usa solo hechos observables. Si falta informacion, no la inventes.
- Si el relato del docente es breve, transforma esa informacion en un registro completo, formal y pedagogico sin inventar hechos no descritos.
- La anotacion debe ser integral y lista para pegar en el libro de clases.
- La anotacion debe incluir en un solo texto: hecho observado, intervencion o dialogo con el estudiante, comunicacion de que el registro sera ingresado, y medida reparatoria o formativa.
- Usa formulas como "Se dialogo con el estudiante", "se le informo el registro de la situacion" y "se acordo/indico como medida formativa..." cuando sean pertinentes.
- La anotacion debe estar bien redactada, en pasado descriptivo, con 4 a 6 oraciones breves.
- No escribas que el estudiante "reconocio", "se comprometio" o "comprendio" si el docente no lo informo.
- Incluye una medida reparatoria o formativa proporcional, no punitiva por defecto.
- Indica que parte del RICE o reglamento se relaciona con la conducta.
- Debes priorizar siempre una referencia del RICE entregado por sobre normativa general.
- Si el RICE no entrega un articulo exacto para la conducta, cita el articulo, titulo, procedimiento o criterio institucional mas cercano.
- Usa "Normativa General de Convivencia Escolar Chilena" solo si no existe ningun fragmento del RICE disponible.
- Elige exactamente una categoria de la lista.
- Si el relato describe una conducta inadecuada observable, prioriza una categoria de conducta inadecuada antes que "Conversacion con estudiante".
- Usa "Conversacion con estudiante" solo cuando el registro principal sea dejar constancia de una entrevista, dialogo, seguimiento o acuerdo, no cuando se esta registrando una conducta ocurrida en clases.
- Responde solo JSON valido, sin markdown.

RICE / Reglamento del establecimiento:
${reglamento ? reglamento.slice(0, 60000) : "Usa el RICE 2025 adjunto del establecimiento. Si no puedes leer el adjunto, usa criterios generales de convivencia escolar chilena y marca la referencia como normativa general."}

Categorias disponibles:
${categorias.map((item, index) => `${index + 1}. ${item}`).join("\n")}

Datos del caso:
- Estudiante: ${cleanText(payload.estudiante) || "No informado"}
- Curso: ${cleanText(payload.curso) || "No informado"}
- Asignatura o espacio: ${cleanText(payload.asignatura) || "No informado"}
- Relato inicial del docente: ${cleanText(payload.descripcion)}

JSON requerido:
{
  "clasificacion": "leve|grave|gravisima|positiva|constancia",
  "categoria": "una categoria exacta de la lista",
  "razon_categoria": "una frase breve y objetiva",
  "anotacion": "registro integral, objetivo, sin juicios de valor, con hecho observado, dialogo con estudiante, informacion del registro y medida reparatoria/formativa en 4 a 6 oraciones breves",
  "fundamento_reglamento": {
    "parte": "capitulo, articulo, numeral, protocolo o criterio del RICE encontrado",
    "cita_breve": "cita breve o referencia concreta del RICE; si no hay articulo exacto, referencia el criterio mas cercano",
    "explicacion": "por que esa parte del RICE se relaciona con la conducta observada"
  },
  "medida_reparatoria": "medida formativa/reparatoria concreta y proporcional",
  "pasos": ["paso concreto 1", "paso concreto 2", "paso concreto 3"],
  "advertencia": "breve nota si falta informacion o si la referencia es general"
}
  `);
}

function buildAnotacionParts(payload) {
  const prompt = buildAnotacionPrompt(payload);
  const hasUploadedReglamento = cleanText(payload.reglamento).length > 80;
  if (hasUploadedReglamento || fs.existsSync(DEFAULT_RICE_TEXT_PATH) || !fs.existsSync(DEFAULT_RICE_PATH)) {
    return [{ text: prompt }];
  }

  return [
    {
      inline_data: {
        mime_type: "application/pdf",
        data: fs.readFileSync(DEFAULT_RICE_PATH).toString("base64")
      }
    },
    { text: prompt }
  ];
}

function getDefaultRiceText() {
  if (defaultRiceTextCache) return defaultRiceTextCache;
  if (!fs.existsSync(DEFAULT_RICE_TEXT_PATH)) return "";
  defaultRiceTextCache = cleanText(fs.readFileSync(DEFAULT_RICE_TEXT_PATH, "utf8"));
  return defaultRiceTextCache;
}

function getDefaultRiceContext(payload) {
  const text = getDefaultRiceText();
  if (!text) return "";

  const needles = [
    "Conocer sus anotaciones",
    "anotaciÃ³n positiva",
    "ArtÃ­culo 1: Falta Leve",
    "ArtÃ­culo 2: Falta grave",
    "ArtÃ­culo 3: Falta gravÃ­sima",
    "Medidas disciplinarias formativas",
    "Toda inasistencia deberÃ¡ ser justificada",
    "inasistencias a evaluaciones",
    "DesregulaciÃ³n Emocional y Conductual",
    "RESPONSABLES: Docentes",
    "PLAN DE ACCIÃ“N PARA INTERVENCIÃ“N DE CONDUCTAS GRAVES O GRAVÃSIMAS",
    cleanText(payload.descripcion).slice(0, 120),
    cleanText(payload.asignatura)
  ].filter(Boolean);

  const chunks = [];
  const lower = text.toLowerCase();
  needles.forEach((needle) => {
    const index = lower.indexOf(cleanText(needle).toLowerCase());
    if (index === -1) return;
    const start = Math.max(0, index - 1800);
    const end = Math.min(text.length, index + 3600);
    const chunk = cleanText(text.slice(start, end));
    if (chunk && !chunks.some((item) => item.includes(chunk.slice(0, 180)))) {
      chunks.push(chunk);
    }
  });

  if (!chunks.length) {
    return text.slice(0, 60000);
  }

  return cleanText(chunks.map((chunk, index) => `FRAGMENTO RICE ${index + 1}:\n${chunk}`).join("\n\n---\n\n"));
}

function ensureRiceReference(result, payload) {
  if (cleanText(payload.reglamento).length > 80) return result;

  const fundamento = result.fundamento_reglamento || {};
  const category = cleanText(result.categoria).toLowerCase();
  const classification = cleanText(result.clasificacion).toLowerCase();
  const description = cleanText(payload.descripcion).toLowerCase();

  let reference = {
    parte: "RICE 2025, TÃ­tulo IX, ArtÃ­culo 1; TÃ­tulo XI, ArtÃ­culo 1 (Falta Leve)",
    cita_breve: "Procedimientos: diÃ¡logo personal pedagÃ³gico y formativo, registro en hoja de vida; para falta leve, registro, entrevista profesor-estudiante y medida formativa ante reiteraciÃ³n.",
    explicacion: "La conducta se vincula con el procedimiento institucional para registrar situaciones que afectan el desempeÃ±o escolar o el bien comÃºn sin constituir daÃ±o grave."
  };

  if (category.includes("felicitaciones") || category.includes("agradecimiento") || classification.includes("positiva")) {
    reference = {
      parte: "RICE 2025, Reconocimientos, ArtÃ­culos 1 a 3",
      cita_breve: "Toda actitud o acciÃ³n destacada por representar virtudes y valores del Proyecto Educativo serÃ¡ reconocida mediante anotaciÃ³n positiva u otros estÃ­mulos.",
      explicacion: "El registro corresponde a una conducta positiva que el RICE permite reconocer como antecedente de distinciones y premios."
    };
  } else if (category.includes("inasistencia")) {
    reference = {
      parte: "RICE 2025, Asistencia, ArtÃ­culos 8 y 9",
      cita_breve: "Toda inasistencia deberÃ¡ ser justificada por el apoderado el dÃ­a del reintegro; las inasistencias a evaluaciones deben cumplir el reglamento de evaluaciÃ³n.",
      explicacion: "El registro se relaciona con el deber de justificar inasistencias y seguir el procedimiento institucional correspondiente."
    };
  } else if (category.includes("desregulaciÃ³n")) {
    reference = {
      parte: "RICE 2025, Protocolo de respuesta a situaciones de DesregulaciÃ³n Emocional y Conductual",
      cita_breve: "El protocolo establece responsables y etapas de abordaje para episodios de desregulaciÃ³n emocional/conductual durante la jornada escolar.",
      explicacion: "La situaciÃ³n debe abordarse desde el protocolo DEC, priorizando contenciÃ³n, registro de lo ocurrido y comunicaciÃ³n segÃºn etapa."
    };
  } else if (category.includes("dispositivo") || description.includes("celular") || description.includes("telÃ©fono")) {
    reference = {
      parte: "RICE 2025, TÃ­tulo X, ArtÃ­culo 2, numerales 7 y 8; TÃ­tulo XI, ArtÃ­culo 2",
      cita_breve: "Se considera falta grave el uso de celular sin autorizaciÃ³n dentro del aula y el uso de reproductor de audio dentro de la sala de clases.",
      explicacion: "La conducta se vincula con el uso no autorizado de dispositivos durante la clase, descrito por el RICE como falta grave."
    };
  } else if (classification.includes("grave") && !classification.includes("grav")) {
    reference = {
      parte: "RICE 2025, TÃ­tulo X, ArtÃ­culo 2; TÃ­tulo XI, ArtÃ­culo 2",
      cita_breve: "Las faltas graves son aquellas que afectan seriamente el bien comÃºn; su procedimiento considera registro, entrevista, citaciÃ³n al apoderado y medida formativa o disciplinaria segÃºn reiteraciÃ³n.",
      explicacion: "La conducta se relaciona con afectaciÃ³n seria del bien comÃºn o del normal desarrollo de la jornada escolar."
    };
  } else if (classification.includes("gravisima") || classification.includes("gravÃ­sima")) {
    reference = {
      parte: "RICE 2025, TÃ­tulo X, ArtÃ­culo 3; TÃ­tulo XI, ArtÃ­culo 3",
      cita_breve: "Las faltas gravÃ­simas ponen en serio riesgo la integridad fÃ­sica o psicolÃ³gica de integrantes de la comunidad educativa, el bien comÃºn o la sana convivencia.",
      explicacion: "La conducta debe vincularse al procedimiento para faltas gravÃ­simas cuando existe riesgo serio o afectaciÃ³n grave de la convivencia."
    };
  }

  result.fundamento_reglamento = {
    ...fundamento,
    ...reference
  };
  return result;
}

function validateAnotacionPayload(payload) {
  if (!cleanText(payload.estudiante)) {
    return "Falta el nombre del estudiante.";
  }
  if (!cleanText(payload.descripcion)) {
    return "Falta la descripcion de lo ocurrido.";
  }
  return "";
}

async function extractReglamento(payload) {
  const fileName = cleanText(payload.fileName);
  const mimeType = cleanText(payload.mimeType) || "application/pdf";
  const data = cleanText(payload.data);
  if (!data) {
    throw new Error("No se recibio el archivo del reglamento.");
  }

  const prompt = cleanText(`
Extrae el texto util de este RICE o reglamento de convivencia escolar.
Prioriza:
- articulos, capitulos o numerales
- tipos de faltas
- criterios para registros/anotaciones
- medidas formativas, reparatorias y protocolos
- procedimientos de comunicacion al estudiante y apoderado

Devuelve solo texto limpio, sin comentarios. Archivo: ${fileName || "sin nombre"}
  `);

  return callGeminiParts([
    {
      inline_data: {
        mime_type: mimeType,
        data
      }
    },
    { text: prompt }
  ], {
    temperature: 0,
    maxOutputTokens: 8192
  });
}

async function reformatGeminiResponse(originalPrompt, rawResponse) {
  const repairPrompt = cleanText(`
Necesito que reformatees y completes una respuesta previa para que quede usable por un docente.

Objetivo:
- Si la respuesta previa ya contiene una prueba adaptada, reorganÃ­zala.
- Si la respuesta previa solo contiene resumen de cambios y justificaciÃ³n, reconstruye una prueba adaptada coherente usando el contexto del encargo original.
- No escribas explicaciones meta.

Reglas no negociables:
- La prueba adaptada final debe quedar en 100 puntos y declararlo de forma visible.
- Debe conservar todas las preguntas si la prueba original tiene 10 preguntas o menos.
- Debe conservar el orden, la numeracion y la cobertura de la prueba original.
- No puede cambiar operaciones matematicas ni signos originales.
- No puede quedar cortada ni incompleta.

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
    : "- Usa adecuaciones razonables segÃºn el perfil del estudiante.";

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

- ObservaciÃ³n docente:
${cleanText(payload.teacherNote) || "Sin observaciÃ³n adicional."}

Prueba original:
${cleanText(payload.evaluationText)}

Si te ayuda, esta fue una respuesta previa incompleta:
${cleanText(rawResponse)}

Tarea:
- Reescribe la prueba completa en versiÃ³n adaptada.
- Conserva el foco evaluativo.
- Conserva la estructura general, las secciones y casi todos los items de la prueba original.
- Mantiene el mismo orden de secciones, preguntas, subitems y alternativas de la prueba original siempre que sea posible.
- Respeta la numeracion original. Si debes renumerar, hazlo de forma correlativa, limpia y sin saltos.
- Mantiene un formato lo mas parecido posible al original.
- Si la prueba original tiene 10 preguntas o menos, conserva todas las preguntas.
- No cambies signos, operaciones, datos numericos ni alternativas correctas de la prueba original.
- Si una pregunta original usa suma, resta, multiplicacion o division, la adaptacion debe mantener esa misma operacion.
- Si se pidiÃ³ reducir cantidad de items, reduce solo de forma moderada.
- Nunca dejes la evaluaciÃ³n reducida a una sola pregunta si originalmente tenÃ­a varias.
- La version final debe quedar en puntaje total de 100 puntos.
- Si la prueba original usa otro puntaje, redistribuye los valores para cerrar en 100 puntos exactos.
- Debes escribir de forma visible "Puntaje total: 100 puntos" o equivalente directo.
- La prueba debe quedar completa hasta la ultima pregunta o ultimo subitem correspondiente.
- Ajusta lenguaje, instrucciones, cantidad de apoyo y formato de respuesta segÃºn el perfil del estudiante.
- No expliques los cambios.
- No escribas resumen ni justificaciÃ³n.

Responde solamente con el texto final de la prueba adaptada.
  `);

  return callGemini(prompt);
}

async function regenerateWithStructureGuard(payload, currentAdapted) {
  const supports = Array.isArray(payload.supports) && payload.supports.length
    ? payload.supports.map((item) => `- ${item}`).join("\n")
    : "- Usa adecuaciones razonables segÃºn el perfil del estudiante.";

  const prompt = cleanText(`
Necesito rehacer una prueba adaptada porque quedÃ³ demasiado reducida.

Reglas obligatorias:
- Respeta la prueba original como base principal.
- Conserva secciones, numeraciÃ³n y secuencia general.
- MantÃ©n el mismo orden de secciones, preguntas, subitems y alternativas de la prueba original siempre que sea posible.
- Respeta la numeraciÃ³n original. Si debes renumerar, hazlo de forma correlativa, limpia y sin saltos.
- MantÃ©n un formato lo mÃ¡s parecido posible al original.
- MantÃ©n casi todos los Ã­tems originales.
- Si la prueba original tiene 10 preguntas o menos, conserva todas las preguntas.
- No cambies signos, operaciones, datos numericos ni alternativas correctas de la prueba original.
- Si una pregunta original usa suma, resta, multiplicacion o division, la adaptacion debe mantener esa misma operacion.
- Si se pidiÃ³ reducir cantidad de items, la reducciÃ³n debe ser moderada, nunca extrema.
- Si la prueba original tiene 5 o mÃ¡s Ã­tems, conserva al menos 3 y procura mantener 60% o mÃ¡s.
- Nunca entregues una sola pregunta si la evaluaciÃ³n original tenÃ­a varias.
- La version final debe quedar en puntaje total de 100 puntos.
- Si la prueba original usa otro puntaje, redistribuye los valores para cerrar en 100 puntos exactos.
- Debes escribir de forma visible "Puntaje total: 100 puntos" o equivalente directo.
- La prueba debe quedar completa hasta la ultima pregunta o ultimo subitem correspondiente.
- Simplifica, clarifica y agrega apoyos, pero no mutiles la evaluaciÃ³n.
- No escribas explicaciÃ³n, resumen ni justificaciÃ³n.

Contexto:
- Asignatura: ${cleanText(payload.subject) || "No informada"}
- Curso: ${cleanText(payload.course) || "No informado"}
- Objetivo de aprendizaje:
${cleanText(payload.learningGoal) || "No informado"}

- Perfil del estudiante / NEE:
${cleanText(payload.studentProfile)}

- Ajustes que se deben privilegiar:
${supports}

- ObservaciÃ³n docente:
${cleanText(payload.teacherNote) || "Sin observaciÃ³n adicional."}

Prueba original:
${cleanText(payload.evaluationText)}

VersiÃ³n adaptada anterior que debes corregir:
${cleanText(currentAdapted)}

Responde solamente con la prueba adaptada final completa.
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
    const errorText = data?.error?.message || `Gemini devolviÃ³ HTTP ${response.status}`;
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
    /^no se recibi[oÃ³].*v[aÃ¡]lida\.?$/
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
      const bulletish = lines.filter((line) => /^[-*â€¢\d]/.test(line));
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
    warnings.push("Gemini no respetÃ³ los marcadores, asÃ­ que se rescatÃ³ la respuesta completa como prueba adaptada.");
  }

  if (isPlaceholderContent(adapted)) warnings.push("La prueba adaptada vino vacÃ­a o con texto de ejemplo.");
  if (isPlaceholderContent(summary)) warnings.push("El resumen de cambios vino vacÃ­o o con texto de ejemplo.");
  if (isPlaceholderContent(teacher)) warnings.push("La justificaciÃ³n docente vino vacÃ­a o con texto de ejemplo.");

  const teacherTable = parseTeacherTable(teacher);

  return {
    adapted: isPlaceholderContent(adapted) ? "No se recibiÃ³ una prueba adaptada vÃ¡lida." : adapted,
    summary: isPlaceholderContent(summary) ? "No se recibiÃ³ un resumen de cambios vÃ¡lido." : summary,
    teacher: isPlaceholderContent(teacher) ? "No se recibiÃ³ una justificaciÃ³n docente vÃ¡lida." : teacher,
    teacher_rows: teacherTable.rows,
    teacher_note: teacherTable.note,
    warnings
  };
}

function mergeAdaptedIntoParsed(parsed, adaptedText) {
  const cleaned = cleanText(adaptedText);
  if (cleaned && !isPlaceholderContent(cleaned)) {
    parsed.adapted = adaptedText;
    parsed.warnings = parsed.warnings.filter((item) => !item.includes("La prueba adaptada vino vacÃ­a"));
    if (!parsed.warnings.includes("La prueba adaptada se reconstruyÃ³ con una solicitud adicional automÃ¡tica.")) {
      parsed.warnings.unshift("La prueba adaptada se reconstruyÃ³ con una solicitud adicional automÃ¡tica.");
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

  if (req.method === "GET" && (url.pathname === "/anotaciones" || url.pathname === "/anotaciones.html")) {
    sendHtml(res, ANOTACIONES_HTML_PATH);
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

      const prompt = buildPromptStrict(payload);
      let rawResponse = await callGemini(prompt);
      let parsed = parseGeminiResponse(rawResponse);

      const needsRepair =
        parsed.adapted === "No se recibiÃ³ una prueba adaptada vÃ¡lida." &&
        (parsed.summary !== "No se recibiÃ³ un resumen de cambios vÃ¡lido." ||
          parsed.teacher !== "No se recibiÃ³ una justificaciÃ³n docente vÃ¡lida.");

      if (needsRepair) {
        rawResponse = await reformatGeminiResponse(prompt, rawResponse);
        parsed = parseGeminiResponse(rawResponse);
        if (!parsed.warnings.includes("La primera respuesta de Gemini venÃ­a incompleta y se intentÃ³ reparar automÃ¡ticamente.")) {
          parsed.warnings.unshift("La primera respuesta de Gemini venÃ­a incompleta y se intentÃ³ reparar automÃ¡ticamente.");
        }
      }

      if (parsed.adapted === "No se recibiÃ³ una prueba adaptada vÃ¡lida.") {
        const adaptedOnly = await generateAdaptedOnly(payload, rawResponse);
        parsed = mergeAdaptedIntoParsed(parsed, adaptedOnly);
        if (parsed.adapted === "No se recibiÃ³ una prueba adaptada vÃ¡lida.") {
          const cleanedFallback = cleanText(adaptedOnly);
          if (cleanedFallback.length > 120) {
            parsed.adapted = cleanedFallback;
            parsed.warnings = parsed.warnings.filter((item) => !item.includes("La prueba adaptada vino vacÃ­a"));
            parsed.warnings.unshift("La prueba adaptada se rescatÃ³ desde una respuesta libre de Gemini.");
          }
        }
      }

      const rebuildReasons = parsed.adapted !== "No se recibiÃ³ una prueba adaptada vÃ¡lida."
        ? needsStructuralRebuild(payload.evaluationText, parsed.adapted)
        : [];

      if (parsed.adapted !== "No se recibiÃ³ una prueba adaptada vÃ¡lida." && rebuildReasons.length) {
        const rebuiltAdapted = await regenerateWithStructureGuard(payload, parsed.adapted);
        if (cleanText(rebuiltAdapted)) {
          parsed = mergeAdaptedIntoParsed(parsed, rebuiltAdapted);
          parsed.warnings.unshift(`La primera adaptación tuvo problemas estructurales y se reconstruyó automáticamente. ${rebuildReasons.join(" ")}`);
        }
      }

      sendJson(res, 200, parsed);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Error inesperado al generar la adaptaciÃ³n." });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/extract-reglamento") {
    try {
      const rawBody = await readRequestBody(req);
      const payload = JSON.parse(rawBody || "{}");
      const text = await extractReglamento(payload);
      if (!text || text.length < 80) {
        sendJson(res, 422, { error: "No se pudo extraer texto suficiente del reglamento." });
        return;
      }
      sendJson(res, 200, { text });
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Error inesperado al leer el reglamento." });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/anotacion") {
    try {
      const rawBody = await readRequestBody(req);
      const payload = JSON.parse(rawBody || "{}");
      const validationError = validateAnotacionPayload(payload);
      if (validationError) {
        sendJson(res, 400, { error: validationError });
        return;
      }

      const rawResponse = await callGeminiParts(buildAnotacionParts(payload), {
        temperature: 0.15,
        maxOutputTokens: 2048
      });
      const parsed = ensureRiceReference(parseJsonObject(rawResponse), payload);
      sendJson(res, 200, parsed);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Error inesperado al generar la anotacion." });
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

