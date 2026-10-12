const Uso = require('../models/uso');

const RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const TRANSCRIPTIONS_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DECISIONS_API_URL = 'https://api.openai.com/v1/decisions';
let registroPendiente = Promise.resolve();

function crearConfiguracion(opciones = {}) {
    const modelo = opciones.modelo || process.env.OPENAI_MODEL || 'gpt-6-luna';
    if (typeof modelo !== 'string' || !modelo.trim()) throw new Error('Indicá un modelo válido.');
    const configuracion = {
        maxTokensSalida: 1000, json: false,
        razonamiento: /^gpt-[56]/.test(modelo) ? 'low' : undefined,
        ...opciones, modelo,
    };
    if (!Number.isInteger(configuracion.maxTokensSalida) || configuracion.maxTokensSalida < 1) {
        throw new Error('maxTokensSalida debe ser un entero positivo.');
    }
    return configuracion;
}

function validarTexto(texto) {
    if (typeof texto !== 'string' || !texto.trim()) throw new Error('El texto no puede estar vacío.');
    if (texto.length > 30000) throw new Error('El texto no puede superar los 30000 caracteres.');
}

function crearCuerpo(input, configuracion) {
    const cuerpo = { model: configuracion.modelo, input, max_output_tokens: configuracion.maxTokensSalida, store: false };
    if (configuracion.instrucciones !== undefined) {
        validarTexto(configuracion.instrucciones);
        cuerpo.instructions = configuracion.instrucciones;
    }
    if (configuracion.razonamiento) cuerpo.reasoning = { effort: configuracion.razonamiento };
    if (configuracion.esquema) {
        const { nombre, schema } = configuracion.esquema;
        if (typeof nombre !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(nombre) || !schema || schema.type !== 'object') throw new Error('Esquema JSON inválido.');
        cuerpo.text = { format: { type: 'json_schema', name: nombre, schema, strict: true } };
    } else if (configuracion.json) {
        cuerpo.text = { format: { type: 'json_object' } };
        cuerpo.instructions = `Respondé en formato JSON.\n${cuerpo.instructions || ''}`;
    }
    return cuerpo;
}

function obtenerUso(datos) {
    const entrada = datos?.usage?.input_tokens ?? datos?.usage?.prompt_tokens ?? null;
    const salida = datos?.usage?.output_tokens ?? datos?.usage?.completion_tokens ?? null;
    const total = datos?.usage?.total_tokens ?? (entrada !== null && salida !== null ? entrada + salida : null);
    return { entrada, salida, total };
}

// Comprobar y registrar juntos evita que llamadas simultáneas del servidor excedan el cupo.
// Esta cola es local: si se ejecutan varios procesos, el control debe hacerse en MongoDB.
function registrarUso(tipo, modelo, segundos, configuracion, signal, entrada) {
    const registro = registroPendiente.then(async () => {
        if (Uso.db.readyState !== 1) throw new Error('MongoDB debe estar conectado para registrar el uso de OpenAI.');
        const ahora = new Date();
        const inicioMes = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));
        const [consumo = { consultas: 0, busquedas: 0, segundos: 0 }] = await Uso.aggregate([
            { $match: { servicio: 'openai', createdAt: { $gte: inicioMes }, estado: { $ne: 'rechazado' } } },
            { $group: {
                _id: null,
                consultas: { $sum: { $cond: [{ $or: ['$esTexto', '$esImagen'] }, 1, 0] } },
                busquedas: { $sum: { $cond: ['$esBusquedaWeb', 1, 0] } },
                segundos: { $sum: { $cond: ['$esAudio', '$segundos', 0] } },
            } },
        ]);
        const limiteTexto = Number(process.env.LLM_MONTHLY_TEXT_QUERY_LIMIT ?? 1000);
        const limiteWeb = Number(process.env.LLM_MONTHLY_WEB_SEARCH_LIMIT ?? 100);
        const limiteAudio = Number(process.env.LLM_MONTHLY_AUDIO_SECONDS_LIMIT ?? 3600);
        if (![limiteTexto, limiteWeb, limiteAudio].every(valor => Number.isFinite(valor) && valor >= 0)) {
            throw new Error('Los límites mensuales deben ser números mayores o iguales a cero.');
        }
        if (tipo !== 'audio' && consumo.consultas + 1 > limiteTexto) throw new Error('Se alcanzó el límite mensual de consultas de OpenAI.');
        if (tipo === 'web' && consumo.busquedas + 1 > limiteWeb) throw new Error('Se alcanzó el límite mensual de búsquedas web.');
        if (tipo === 'audio' && consumo.segundos + segundos > limiteAudio) throw new Error('Se alcanzó el límite mensual de segundos de audio.');
        signal.throwIfAborted();
        return Uso.create({
            ...entrada,
            servicio: 'openai', modelo, estado: 'pendiente', segundos,
            esTexto: tipo === 'texto' || tipo === 'web' || tipo === 'decision', esImagen: tipo === 'imagen',
            esBusquedaWeb: tipo === 'web', esAudio: tipo === 'audio',
            esDecision: tipo === 'decision',
            conversacionId: configuracion.conversacionId,
        });
    });
    registroPendiente = registro.catch(() => {});
    return registro;
}

// Todas las APIs pasan por acá: límite, llamada y guardado del uso.
async function consultarOpenAI(url, cuerpo, configuracion, tipo, segundos = 0, entrada = {}) {
    if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('Falta definir OPENAI_API_KEY.');
    const signal = configuracion.signal
        ? AbortSignal.any([configuracion.signal, AbortSignal.timeout(90000)])
        : AbortSignal.timeout(90000);
    signal.throwIfAborted();
    const uso = await registrarUso(tipo, cuerpo.model || configuracion.modelo, segundos, configuracion, signal, entrada);
    const inicio = performance.now();
    let respuesta, datos, enviado = false;
    try {
        signal.throwIfAborted();
        const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
        if (tipo !== 'audio') headers['Content-Type'] = 'application/json';
        enviado = true;
        respuesta = await fetch(url, {
            method: 'POST', headers, body: tipo === 'audio' ? cuerpo : JSON.stringify(cuerpo), signal,
        });
        datos = await respuesta.json();
        const tokens = obtenerUso(datos);
        uso.tokensEntrada = tokens.entrada;
        uso.tokensSalida = tokens.salida;
        uso.tokensTotal = tokens.total;
        if (tipo === 'decision') uso.usoDetalle = datos.usage;
        if (!respuesta.ok) throw new Error(datos.error?.message || 'No fue posible consultar OpenAI.');
        if (datos.status === 'incomplete' || datos.status === 'failed' || datos.error) throw new Error('OpenAI no pudo completar la respuesta.');
        if (tipo === 'decision') {
            uso.respuestasDecision = datos.answers;
            const resultado = datos.answers?.[0];
            if (!Array.isArray(datos.answers) || datos.answers.length !== 1 || !['choice', 'refusal'].includes(resultado?.type)) {
                throw new Error('OpenAI no devolvió una decisión válida.');
            }
            if (resultado.type === 'choice' && (!cuerpo.questions[0].choices.some(opcion => opcion.value === resultado.choice)
                || !Number.isFinite(resultado.confidence) || resultado.confidence < 0 || resultado.confidence > 1)) {
                throw new Error('OpenAI devolvió una opción o confianza inválida.');
            }
            // Una negativa es una respuesta tipada y puede consumir tokens.
            uso.estado = 'completado';
            return { resultado, tokensGastados: tokens, uso: datos.usage, modelo: datos.model || cuerpo.model,
                tiempoRespuestaMs: Math.round(performance.now() - inicio) };
        }
        const contenidos = (datos.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []);
        if (contenidos.some(item => item.type === 'refusal')) throw new Error('OpenAI rechazó la solicitud.');
        const resultado = tipo === 'audio' ? datos.text : datos.output_text || contenidos.filter(item => item.type === 'output_text').map(item => item.text).join('\n');
        if (typeof resultado !== 'string' || !resultado.trim()) throw new Error('OpenAI no devolvió contenido.');
        if ((configuracion.json || configuracion.esquema) && tipo !== 'audio') JSON.parse(resultado);
        uso.estado = 'completado';
        return {
            resultado: configuracion.esquema && tipo !== 'audio' ? JSON.parse(resultado) : resultado,
            tokensGastados: tokens, tiempoRespuestaMs: Math.round(performance.now() - inicio),
            fuentes: contenidos.flatMap(item => item.annotations || []).filter(item => item.type === 'url_citation').map(({ url, title }) => ({ url, titulo: title || url })),
            ...(tipo === 'audio' && { segundosAudio: segundos }),
        };
    } catch (error) {
        // Los errores de red conservan cupo: la solicitud puede haber sido procesada.
        const rechazado = !enviado || (respuesta?.status >= 400 && respuesta.status < 500 && respuesta.status !== 408 && !datos?.usage);
        uso.estado = rechazado ? 'rechazado' : datos?.status === 'incomplete' ? 'incompleto' : 'fallido';
        error.tokensGastados = obtenerUso(datos);
        throw error;
    } finally {
        uso.tiempoRespuestaMs = Math.round(performance.now() - inicio);
        await uso.save();
    }
}

async function procesarTexto(texto, opciones = {}) {
    validarTexto(texto);
    const configuracion = crearConfiguracion(opciones);
    return consultarOpenAI(RESPONSES_API_URL, crearCuerpo(texto, configuracion), configuracion, 'texto', 0, {
        texto, contexto: configuracion.instrucciones,
    });
}

async function procesarDecision(prompt, opciones, configuracion = {}) {
    validarTexto(prompt);
    if (!configuracion || typeof configuracion !== 'object' || Array.isArray(configuracion)) {
        throw new Error('La configuración de Decisions debe ser un objeto.');
    }
    if (!Array.isArray(opciones) || opciones.length < 2 || opciones.length > 255) {
        throw new Error('Decisions requiere entre 2 y 255 opciones.');
    }
    const choices = opciones.map(opcion => {
        const choice = typeof opcion === 'string' || typeof opcion === 'boolean' ? { value: opcion } : opcion;
        if (!choice || !['string', 'boolean'].includes(typeof choice.value)) {
            throw new Error('Cada opción debe ser un string, booleano o un objeto con value y description opcional.');
        }
        if (typeof choice.value === 'string') validarTexto(choice.value);
        if (choice.description !== undefined) validarTexto(choice.description);
        return { value: choice.value, ...(choice.description !== undefined && { description: choice.description }) };
    });
    if (new Set(choices.map(opcion => opcion.value)).size !== choices.length) throw new Error('Las opciones deben ser únicas.');
    const modelo = configuracion.modelo || process.env.OPENAI_DECISIONS_MODEL || 'gpt-6-luna';
    validarTexto(modelo);
    const instrucciones = configuracion.instrucciones ?? 'Elegí la opción que mejor corresponda al texto de entrada.';
    validarTexto(instrucciones);
    const nombre = configuracion.nombre ?? 'decision';
    validarTexto(nombre);
    for (const parametro of ['json', 'maxTokensSalida', 'razonamiento']) {
        if (configuracion[parametro] !== undefined) throw new Error(`Decisions no admite la opción ${parametro}.`);
    }
    const cuerpo = { model: modelo, input: prompt, questions: [{ type: 'choice', name: nombre, instructions: instrucciones, choices }] };
    if (configuracion.safetyIdentifier !== undefined) {
        validarTexto(configuracion.safetyIdentifier);
        if (configuracion.safetyIdentifier.length > 128) throw new Error('safetyIdentifier no puede superar los 128 caracteres.');
        cuerpo.safety_identifier = configuracion.safetyIdentifier;
    }
    return consultarOpenAI(DECISIONS_API_URL, cuerpo, { ...configuracion, modelo }, 'decision', 0, {
        texto: prompt, contexto: instrucciones, preguntasDecision: cuerpo.questions,
    });
}

async function procesarImagen(imagenUrl, prompt = 'Describí esta imagen.', opciones = {}) {
    validarTexto(prompt);
    if (typeof imagenUrl !== 'string' || !/^(https?:\/\/|data:image\/)/.test(imagenUrl)) throw new Error('Indicá una URL HTTP(S) o una imagen en base64.');
    const configuracion = crearConfiguracion(opciones);
    const input = [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imagenUrl }] }];
    return consultarOpenAI(RESPONSES_API_URL, crearCuerpo(input, configuracion), configuracion, 'imagen', 0, {
        imagenUrl, contexto: [configuracion.instrucciones, prompt].filter(Boolean).join('\n'),
    });
}

async function transcribirAudio(buffer, mimeType = 'audio/webm', opciones = {}) {
    // El audio se guarda en el documento de Uso; 15 MB deja margen bajo el límite de MongoDB.
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 15000000) throw new Error('El audio debe ser un Buffer de hasta 15 MB.');
    const tipo = mimeType.split(';')[0].trim().toLowerCase();
    const extensiones = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/x-m4a': 'm4a' };
    if (!extensiones[tipo]) throw new Error('Formato de audio no compatible.');
    if (opciones.json) throw new Error('La transcripción devuelve texto; aplicá JSON con procesarTexto.');
    if (opciones.prompt !== undefined) validarTexto(opciones.prompt);
    const contexto = opciones.prompt || 'Transcribí este audio.';
    const { parseBuffer } = await import('music-metadata');
    const { format } = await parseBuffer(buffer, { mimeType: tipo, size: buffer.length }, { duration: true });
    const segundosAudio = Math.ceil(format.duration);
    if (!Number.isFinite(segundosAudio) || segundosAudio <= 0) throw new Error('No se pudo determinar la duración del audio.');
    const modelo = opciones.modeloAudio || opciones.modelo || process.env.OPENAI_TRANSCRIPTION_MODEL || process.env.OPENAI_AUDIO_MODEL || 'gpt-4o-mini-transcribe';
    const configuracion = crearConfiguracion({ ...opciones, modelo });
    const cuerpo = new FormData();
    cuerpo.append('file', new Blob([buffer], { type: tipo }), `audio.${extensiones[tipo]}`);
    cuerpo.append('model', modelo);
    cuerpo.append('language', 'es');
    cuerpo.append('response_format', 'json');
    cuerpo.append('prompt', contexto);
    return consultarOpenAI(TRANSCRIPTIONS_API_URL, cuerpo, configuracion, 'audio', segundosAudio, {
        audio: buffer, audioMimeType: tipo, contexto,
    });
}

async function procesarAudio(audioBase64, formato = 'webm', prompt = 'Transcribí este audio.', opciones = {}) {
    if (typeof audioBase64 !== 'string' || !audioBase64.length || audioBase64.length > 33333336 || audioBase64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64)) throw new Error('Audio en base64 inválido.');
    const tipos = { webm: 'audio/webm', mp4: 'audio/mp4', m4a: 'audio/x-m4a', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };
    if (!tipos[formato]) throw new Error('Formato de audio no compatible.');
    return transcribirAudio(Buffer.from(audioBase64, 'base64'), tipos[formato], { ...opciones, prompt });
}

async function procesarBusquedaWeb(consulta, opciones = {}) {
    validarTexto(consulta);
    const configuracion = crearConfiguracion(opciones);
    const cuerpo = crearCuerpo(consulta, configuracion);
    cuerpo.tools = [{ type: 'web_search' }];
    cuerpo.tool_choice = 'required';
    cuerpo.max_tool_calls = 1;
    return consultarOpenAI(RESPONSES_API_URL, cuerpo, configuracion, 'web', 0, {
        busqueda: consulta, contexto: configuracion.instrucciones,
    });
}

module.exports = { procesarTexto, procesarImagen, procesarAudio, transcribirAudio, procesarBusquedaWeb, procesarDecision };
