# AdaptaEval

Versión simple para docentes con frontend web y backend mínimo para Gemini.

## La opción más práctica

La mejor opción real es esta:

- tú o una persona administradora configura una sola vez el servidor
- luego los docentes usan una web simple
- los profesores no instalan modelos ni tocan nada técnico

## Si quieres probarlo tú mismo en este computador

### Paso 1. Instala Node.js

Instala Node.js 18 o superior desde:

https://nodejs.org/

### Paso 2. Consigue tu clave de Gemini

Genera una API key en Google AI Studio:

https://aistudio.google.com/

### Paso 3. Crea tu archivo `.env`

1. Duplica el archivo `.env.example`
2. Renómbralo como `.env`
3. Ábrelo y deja algo así:

```env
GEMINI_API_KEY=tu_clave_real_aqui
GEMINI_MODEL=gemini-2.5-flash-lite
PORT=3000
```

## Forma más fácil de iniciar

Haz doble clic en:

`start_adaptaeval.bat`

Eso intentará:

- abrir la web en `http://localhost:3000`
- iniciar el servidor

## Si prefieres iniciar manualmente

Abre una terminal en esta carpeta y ejecuta:

```bash
node server.js
```

Luego abre:

```text
http://localhost:3000
```

## Qué ve el docente

- pega la prueba
- describe el perfil del estudiante
- marca apoyos deseados
- hace clic en `Generar prueba adaptada`

Y recibe:

- prueba adaptada
- resumen de cambios
- justificación docente

## Para usarlo con docentes de verdad

Lo ideal no es que cada profesor lo corra en su computador.

Lo mejor es:

1. subir este proyecto a un servidor o servicio web
2. guardar la `GEMINI_API_KEY` en el servidor
3. compartir solo la URL con los docentes

Así:

- tú administras la parte técnica una vez
- los docentes solo usan la página

## Modelo recomendado

- `gemini-2.5-flash-lite` para partir barato y rápido
- `gemini-2.5-flash` si luego quieres más calidad
