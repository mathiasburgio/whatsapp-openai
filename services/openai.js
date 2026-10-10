const RESPONSES_API_URL = "https://api.openai.com/v1/responses";
const CHAT_COMPLETIONS_API_URL = "https://api.openai.com/v1/chat/completions";
const TRANSCRIPTIONS_API_URL = "https://api.openai.com/v1/audio/transcriptions";


//configuracion por defecto. Se usa solo en "crearConfiguracion"
const CONFIGURACION_POR_DEFECTO = Object.freeze({
    modelo: process.env.OPENAI_MODEL || "gpt-6-luna",
    modeloAudio: process.env.OPENAI_AUDIO_MODEL || "gpt-4o-mini-transcribe",
    maxTokensSalida: 1000,
    json: false
});

//devuelve la configuracion antes de llamar a la API
function crearConfiguracion(opciones = {}) {
    return {
        ...CONFIGURACION_POR_DEFECTO,
        modelo: process.env.OPENAI_MODEL || CONFIGURACION_POR_DEFECTO.modelo,
        modeloAudio: process.env.OPENAI_AUDIO_MODEL || CONFIGURACION_POR_DEFECTO.modeloAudio,
        ...opciones
    };
}

//devuelve los headers necesarios para las solicitudes JSON a la API de OpenAI
function headersJson() {
    if(!process.env.OPENAI_API_KEY) throw new Error("Falta definir OPENAI_API_KEY en las variables de entorno.");
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    };
}

//devuelve un objeto con el uso de tokens de la respuesta de OpenAI
function obtenerUso(datos) {
    return {
        entrada: datos.usage?.input_tokens || datos.usage?.prompt_tokens || 0,
        salida: datos.usage?.output_tokens || datos.usage?.completion_tokens || 0,
        total: datos.usage?.total_tokens || 0
    };
}

//consulta la API de OpenAI con el cuerpo proporcionado y devuelve el resultado procesado
//esta funcion es la unica q verdaderamente llama al LLM
async function consultarOpenAI(cuerpo, signal) {
    const headers = headersJson();
    const inicio = performance.now();
    const respuesta = await fetch(RESPONSES_API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(cuerpo),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000)
    });
    const datos = await respuesta.json();
    if(!respuesta.ok) throw new Error(datos.error?.message || "No fue posible consultar OpenAI.");
    if(datos.status === "incomplete" || datos.status === "failed") throw new Error("OpenAI no pudo completar la respuesta.");
    const contenidos = (datos.output || []).filter((item) => item.type === "message").flatMap((item) => item.content || []);

    return {
        resultado: datos.output_text || contenidos.filter((item) => item.type === "output_text").map((item) => item.text).join("\n"),
        fuentes: contenidos.flatMap((item) => item.annotations || []).filter((item) => item.type === "url_citation").map(({url, title}) => ({url, titulo: title || url})),
        tiempoRespuestaMs: Math.round(performance.now() - inicio),
        tokensGastados: obtenerUso(datos)
    };
}

//llama a consultarOpenAI por texto (tipica consulta tipo chat)
async function procesarTexto(texto, opciones = {}) {
    const configuracion = crearConfiguracion(opciones);
    return consultarOpenAI({
        model: configuracion.modelo,
        max_output_tokens: configuracion.maxTokensSalida,
        ...(configuracion.json && {text: {format: {type: "json_object"}}}),
        ...(configuracion.instrucciones && {instructions: configuracion.instrucciones}),
        // JSON mode exige que también el input mencione JSON, aunque haya instructions.
        input: configuracion.json ? `Respondé en formato JSON.\n\n${texto}` : texto
    }, configuracion.signal);
}

//llama a consultarOpenAI por imagen
async function procesarImagen(imagenUrl, prompt = "Describí esta imagen.", opciones = {}) {
    const configuracion = crearConfiguracion(opciones);
    return consultarOpenAI({
        model: configuracion.modelo,
        max_output_tokens: configuracion.maxTokensSalida,
        input: [{role: "user", content: [{type: "input_text", text: prompt}, {type: "input_image", image_url: imagenUrl}]}]
    });
}

async function procesarAudio(audioBase64, formato = "webm", prompt = "Transcribí este audio.", opciones = {}) {
    const configuracion = crearConfiguracion(opciones);
    const headers = headersJson();
    const segundosAudio = await duracionAudio.obtenerSegundosAudio(Buffer.from(audioBase64, "base64"));
    const inicio = performance.now();
    const respuesta = await fetch(CHAT_COMPLETIONS_API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: configuracion.modeloAudio,
            max_tokens: configuracion.maxTokensSalida,
            ...(configuracion.json && {response_format: {type: "json_object"}}),
            messages: [{
                role: "user",
                content: [
                    {type: "text", text: prompt},
                    {type: "input_audio", input_audio: {data: audioBase64, format: formato}}
                ]
            }]
        })
    });
    const datos = await respuesta.json();
    if(!respuesta.ok) throw new Error(datos.error?.message || "No fue posible procesar el audio.");

    return {
        resultado: datos.choices?.[0]?.message?.content || "",
        tiempoRespuestaMs: Math.round(performance.now() - inicio),
        tokensGastados: obtenerUso(datos),
        segundosAudio
    };
}

// El endpoint de transcripción acepta los archivos webm/mp4 que graba el navegador.
async function transcribirAudio(buffer, mimeType = "audio/webm", opciones = {}) {
    const inicio = performance.now();
    const modelo = opciones.modelo || process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
    const tipo = mimeType.split(";")[0];
    const extensiones = {"audio/webm": "webm", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav"};
    if(!extensiones[tipo]) throw new Error("Formato de audio no compatible con la transcripción.");
    const {Authorization} = headersJson();
    const datos = new FormData();
    datos.append("file", new Blob([buffer], {type: tipo}), `dictado.${extensiones[tipo]}`);
    datos.append("model", modelo);
    datos.append("language", "es");
    if(typeof opciones.prompt === "string" && opciones.prompt.trim()) datos.append("prompt", opciones.prompt.trim());
    datos.append("response_format", "json");
    const respuesta = await fetch(TRANSCRIPTIONS_API_URL, {
        method: "POST",
        headers: {Authorization},
        body: datos,
        signal: AbortSignal.timeout(60_000)
    });
    const cuerpo = await respuesta.json();
    if(!respuesta.ok) throw new Error(cuerpo.error?.message || "No fue posible transcribir el audio.");
    if(!cuerpo.text?.trim()) throw new Error("No se reconoció voz en el audio.");
    return {resultado: cuerpo.text.trim(), tiempoRespuestaMs: Math.round(performance.now() - inicio), tokensGastados: obtenerUso(cuerpo), segundosAudio};
}

async function procesarBusquedaWeb(consulta, opciones = {}) {
    const configuracion = crearConfiguracion(opciones);
    return consultarOpenAI({
        model: configuracion.modelo,
        max_output_tokens: configuracion.maxTokensSalida,
        tools: [{type: "web_search"}],
        tool_choice: "required",
        // Un pedido no puede disparar búsquedas adicionales que excedan el cupo reservado.
        max_tool_calls: 1,
        ...(configuracion.instrucciones && {instructions: configuracion.instrucciones}),
        input: consulta
    }, {consultasTexto: 1, webSearch: 1});
}

module.exports = {
    procesarTexto,
    procesarImagen,
    procesarAudio,
    transcribirAudio,
    procesarBusquedaWeb
};
