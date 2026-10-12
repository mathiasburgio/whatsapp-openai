const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module } = require('node:module');
const mongoose = require('mongoose');
const Uso = require('../models/uso');

function preparar(t) {
    const nombres = ['OPENAI_API_KEY', 'OPENAI_DECISIONS_MODEL', 'LLM_MONTHLY_TEXT_QUERY_LIMIT', 'LLM_MONTHLY_WEB_SEARCH_LIMIT', 'LLM_MONTHLY_AUDIO_SECONDS_LIMIT'];
    const entorno = nombres.map(nombre => [nombre, process.env[nombre]]);
    const fetchOriginal = global.fetch;
    t.after(() => {
        global.fetch = fetchOriginal;
        for (const [nombre, valor] of entorno) {
            if (valor === undefined) delete process.env[nombre];
            else process.env[nombre] = valor;
        }
    });
    process.env.OPENAI_API_KEY = 'clave-de-prueba';
    delete process.env.OPENAI_DECISIONS_MODEL;
    process.env.LLM_MONTHLY_TEXT_QUERY_LIMIT = '10';
    process.env.LLM_MONTHLY_WEB_SEARCH_LIMIT = '10';
    process.env.LLM_MONTHLY_AUDIO_SECONDS_LIMIT = '10';
    const registros = [];
    const modelo = {
        db: { readyState: 1 },
        aggregate: async ([{ $match }]) => {
            assert.equal($match.servicio, 'openai');
            assert.equal($match.estado.$ne, 'rechazado');
            assert.equal($match.createdAt.$gte.getUTCDate(), 1);
            const consumidos = registros.filter(uso => uso.estado !== 'rechazado');
            return [{
                consultas: consumidos.filter(uso => uso.esTexto || uso.esImagen).length,
                busquedas: consumidos.filter(uso => uso.esBusquedaWeb).length,
                segundos: consumidos.filter(uso => uso.esAudio).reduce((total, uso) => total + uso.segundos, 0),
            }];
        },
        create: async datos => {
            const uso = new Uso(datos);
            await uso.validate();
            uso.save = async () => { await uso.validate(); uso.guardado = true; };
            registros.push(uso);
            return uso;
        },
    };
    const filename = path.resolve(__dirname, '../services/openai.js');
    const modulo = new Module(filename);
    modulo.filename = filename;
    modulo.paths = Module._nodeModulePaths(path.dirname(filename));
    modulo.require = nombre => nombre === '../models/uso' ? modelo : require(nombre);
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    return { api: modulo.exports, registros, modelo };
}

function respuesta(datos = {}, status = 200) {
    return new Response(JSON.stringify({
        status: 'completed', output_text: 'Respuesta',
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }, ...datos,
    }), { status, headers: { 'Content-Type': 'application/json' } });
}

function audioWav() {
    const buffer = Buffer.alloc(44 + 16000); // Un segundo de audio PCM mono a 8 kHz.
    buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
    buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
    buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36); buffer.writeUInt32LE(16000, 40);
    return buffer;
}

test('texto, imagen y web respetan las opciones y guardan sus consumos', async t => {
    const { api, registros } = preparar(t);
    const llamadas = [];
    const signal = new AbortController().signal;
    global.fetch = async (url, opciones) => {
        llamadas.push({ url, opciones, cuerpo: JSON.parse(opciones.body) });
        return respuesta({ output_text: '{"respuesta":"Hola"}' });
    };
    const opciones = { json: true, instrucciones: 'Sé breve.', maxTokensSalida: 200, signal };
    const texto = await api.procesarTexto('Hola', opciones);
    await api.procesarImagen('https://example.com/imagen.png', 'Describila', opciones);
    await api.procesarBusquedaWeb('Motos disponibles', opciones);
    assert.equal(texto.tokensGastados.total, 15);
    for (const { opciones: peticion, cuerpo } of llamadas) {
        assert.equal(cuerpo.max_output_tokens, 200);
        assert.equal(cuerpo.store, false);
        assert.equal(cuerpo.text.format.type, 'json_object');
        assert.match(cuerpo.instructions, /JSON.*\nSé breve/);
        assert(peticion.signal instanceof AbortSignal);
    }
    assert.equal(llamadas[2].cuerpo.max_tool_calls, 1);
    assert.equal(registros[1].esImagen, true);
    assert.equal(registros[2].esBusquedaWeb, true);
    assert(registros.every(uso => ['texto', 'imagenUrl', 'busqueda', 'contexto'].every(campo => uso[campo] === undefined)));
    assert(registros.every(uso => uso.guardado && uso.estado === 'completado' && uso.tokensTotal === 15));
});

test('los cupos bloquean antes de enviar, incluso con llamadas simultáneas', async t => {
    const { api, registros } = preparar(t);
    process.env.LLM_MONTHLY_TEXT_QUERY_LIMIT = '1';
    let llamadas = 0;
    global.fetch = async () => { llamadas++; return respuesta(); };
    const resultados = await Promise.allSettled([api.procesarTexto('Uno'), api.procesarTexto('Dos')]);
    assert.equal(resultados.filter(item => item.status === 'fulfilled').length, 1);
    assert.match(resultados.find(item => item.status === 'rejected').reason.message, /límite mensual/);
    assert.equal(llamadas, 1);
    assert.equal(registros.length, 1);
    process.env.LLM_MONTHLY_TEXT_QUERY_LIMIT = '10';
    process.env.LLM_MONTHLY_WEB_SEARCH_LIMIT = '0';
    await assert.rejects(api.procesarBusquedaWeb('Una consulta'), /búsquedas web/);
    process.env.LLM_MONTHLY_AUDIO_SECONDS_LIMIT = '0';
    await assert.rejects(api.transcribirAudio(audioWav(), 'audio/wav'), /segundos de audio/);
    assert.equal(llamadas, 1);
});

test('los prompts del bot usan un esquema JSON estricto y devuelven un objeto', async t => {
    const { api, registros } = preparar(t);
    const schema = { type: 'object', properties: { mensaje: { type: 'string' } }, required: ['mensaje'], additionalProperties: false };
    global.fetch = async (url, opciones) => {
        assert.deepEqual(JSON.parse(opciones.body).text.format, { type: 'json_schema', name: 'respuesta', schema, strict: true });
        return respuesta({ output_text: '{"mensaje":"Hola"}' });
    };
    assert.deepEqual((await api.procesarTexto('Cliente', { instrucciones: 'Reglas.', esquema: { nombre: 'respuesta', schema } })).resultado, { mensaje: 'Hola' });
    assert.equal(registros[0].tokensTotal, 15);
});

test('el audio usa transcripciones, mide duración y registra tokens y segundos', async t => {
    const { api, registros } = preparar(t);
    const mensajeId = new mongoose.Types.ObjectId();
    const prompts = [];
    global.fetch = async (url, opciones) => {
        assert.match(url, /audio\/transcriptions$/);
        assert(opciones.body instanceof FormData);
        assert.equal(opciones.body.get('model'), 'gpt-4o-mini-transcribe');
        prompts.push(opciones.body.get('prompt'));
        assert.equal(opciones.headers['Content-Type'], undefined);
        return respuesta({ text: 'Hola desde audio' });
    };
    const audio = await api.transcribirAudio(audioWav(), 'audio/wav', { mensajeId });
    assert.equal(audio.resultado, 'Hola desde audio');
    assert.equal(audio.segundosAudio, 1);
    assert.equal(registros[0].segundos, 1);
    assert.equal(registros[0].esAudio, true);
    assert.equal(registros[0].tokensTotal, 15);
    assert.equal(String(registros[0].mensajeId), String(mensajeId));
    assert.equal(registros[0].audio, undefined);
    assert.equal(registros[0].audioMimeType, undefined);
    await api.transcribirAudio(audioWav(), 'audio/wav', { prompt: 'Audio sobre motos.' });
    assert.deepEqual(prompts, ['Transcribí este audio.', 'Audio sobre motos.']);
    assert.equal(registros[1].contexto, undefined);
});

test('las respuestas incompletas conservan tokens y los rechazos no consumen cupo', async t => {
    const { api, registros } = preparar(t);
    global.fetch = async () => respuesta({ status: 'incomplete' });
    await assert.rejects(api.procesarTexto('Hola'), /completar/);
    assert.equal(registros[0].estado, 'incompleto');
    assert.equal(registros[0].tokensTotal, 15);
    global.fetch = async () => respuesta({ error: { message: 'Clave inválida' }, usage: undefined }, 401);
    await assert.rejects(api.procesarTexto('Hola'), /Clave inválida/);
    assert.equal(registros[1].estado, 'rechazado');
    global.fetch = async () => { throw new Error('Sin conexión'); };
    await assert.rejects(api.procesarTexto('Hola'), /Sin conexión/);
    assert.equal(registros[2].estado, 'fallido');
    assert.equal(registros[2].tokensTotal, undefined);
    assert.equal(registros[2].guardado, true);
});

test('entradas inválidas, cancelación y MongoDB desconectado no llaman a OpenAI', async t => {
    const { api, registros, modelo } = preparar(t);
    global.fetch = async () => assert.fail('No debe enviar una solicitud');
    await assert.rejects(api.procesarTexto(''), /vacío/);
    await assert.rejects(api.transcribirAudio('inválido!', 'audio/wav'), /Buffer/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.procesarTexto('Hola', { signal: controller.signal }), { name: 'AbortError' });
    modelo.db.readyState = 0;
    await assert.rejects(api.procesarTexto('Hola'), /MongoDB/);
    assert.equal(registros.length, 0);
});

test('Decisions envía prompt, opciones e instrucciones y registra su consumo', async t => {
    const { api, registros } = preparar(t);
    const opciones = [{ value: 'comprar', description: 'Comprar una moto' }, { value: 'otro' }];
    const answer = { type: 'choice', name: 'intencion', choice: 'comprar', confidence: 0.98,
        probabilities: [{ value: 'comprar', probability: 0.98 }, { value: 'otro', probability: 0.02 }] };
    const usage = { input_tokens: 42, output_tokens: 0, total_tokens: 42,
        input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 0 } };
    global.fetch = async (url, peticion) => {
        assert.equal(url, 'https://api.openai.com/v1/decisions');
        assert.deepEqual(JSON.parse(peticion.body), {
            model: 'gpt-6-luna', input: 'Quiero una moto', safety_identifier: 'cliente-123',
            questions: [{ type: 'choice', name: 'intencion', instructions: 'Clasificá al cliente.', choices: opciones }],
        });
        assert(peticion.signal instanceof AbortSignal);
        return new Response(JSON.stringify({ model: 'gpt-6-luna', answers: [answer], usage }));
    };
    const resultado = await api.procesarDecision('Quiero una moto', opciones, {
        instrucciones: 'Clasificá al cliente.', nombre: 'intencion', safetyIdentifier: 'cliente-123',
    });
    assert.deepEqual(resultado.resultado, answer);
    assert.deepEqual(resultado.tokensGastados, { entrada: 42, salida: 0, total: 42 });
    assert.deepEqual(resultado.uso, usage);
    const uso = registros[0].toObject();
    assert.equal(uso.esDecision, true);
    assert.equal(uso.esTexto, true);
    assert(['texto', 'contexto', 'preguntasDecision', 'respuestasDecision', 'usoDetalle'].every(campo => uso[campo] === undefined));
    assert.equal(uso.tokensSalida, 0);
    assert.equal(uso.estado, 'completado');
    assert(registros[0].guardado);
});

test('Decisions comparte cupo con texto y reserva antes de llamadas simultáneas', async t => {
    const { api, registros } = preparar(t);
    process.env.LLM_MONTHLY_TEXT_QUERY_LIMIT = '1';
    let llamadas = 0;
    global.fetch = async () => {
        llamadas++;
        return respuesta({ answers: [{ type: 'choice', choice: 'uno', confidence: 0.8 }] });
    };
    const resultados = await Promise.allSettled([
        api.procesarDecision('Hola', ['uno', 'dos']), api.procesarTexto('Hola'),
    ]);
    assert.equal(resultados.filter(item => item.status === 'fulfilled').length, 1);
    assert.match(resultados.find(item => item.status === 'rejected').reason.message, /límite mensual/);
    assert.equal(llamadas, 1);
    assert.equal(registros.length, 1);
});

test('Decisions conserva negativas tipadas y consumo de errores sin liberar cupo', async t => {
    const { api, registros } = preparar(t);
    global.fetch = async () => respuesta({ answers: [{ type: 'refusal', name: 'decision' }] });
    assert.equal((await api.procesarDecision('Hola', ['uno', 'dos'])).resultado.type, 'refusal');
    assert.equal(registros[0].estado, 'completado');
    global.fetch = async () => respuesta({ answers: [] });
    await assert.rejects(api.procesarDecision('Hola', ['uno', 'dos']), /decisión válida/);
    assert.equal(registros[1].estado, 'fallido');
    assert.equal(registros[1].tokensTotal, 15);
    global.fetch = async () => respuesta({ answers: [{ type: 'choice', choice: 'desconocida', confidence: 0.8 }] });
    await assert.rejects(api.procesarDecision('Hola', ['uno', 'dos']), /opción o confianza/);
    global.fetch = async () => respuesta({ error: { message: 'Modelo no disponible' }, usage: undefined }, 400);
    await assert.rejects(api.procesarDecision('Hola', ['uno', 'dos']), /Modelo no disponible/);
    assert.equal(registros[3].estado, 'rechazado');
    global.fetch = async () => { throw new Error('Sin conexión'); };
    await assert.rejects(api.procesarDecision('Hola', ['uno', 'dos']), /Sin conexión/);
    assert.equal(registros[4].estado, 'fallido');
    assert(registros.every(uso => uso.guardado));
});

test('Decisions valida entradas antes de consumir y respeta modelo, booleanos y cancelación', async t => {
    const { api, registros, modelo } = preparar(t);
    global.fetch = async () => assert.fail('No debe enviar una solicitud');
    await assert.rejects(api.procesarDecision('', ['uno', 'dos']), /vacío/);
    for (const opciones of [undefined, [], ['una'], Array(256).fill('uno')]) {
        await assert.rejects(api.procesarDecision('Hola', opciones), /entre 2 y 255/);
    }
    await assert.rejects(api.procesarDecision('Hola', ['uno', 'uno']), /únicas/);
    for (const opciones of [[1, 2], ['uno', null], ['uno', {}], ['uno', { value: 'dos', description: 12 }]]) {
        await assert.rejects(api.procesarDecision('Hola', opciones));
    }
    for (const configuracion of [null, { instrucciones: '' }, { modelo: 12 }, { safetyIdentifier: 'a'.repeat(129) },
        { json: true }, { maxTokensSalida: 10 }, { razonamiento: 'low' }]) {
        await assert.rejects(api.procesarDecision('Hola', ['uno', 'dos'], configuracion));
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.procesarDecision('Hola', ['uno', 'dos'], { signal: controller.signal }), { name: 'AbortError' });
    modelo.db.readyState = 0;
    await assert.rejects(api.procesarDecision('Hola', ['uno', 'dos']), /MongoDB/);
    assert.equal(registros.length, 0);
    modelo.db.readyState = 1;
    process.env.OPENAI_DECISIONS_MODEL = 'modelo-configurado';
    const modelos = [];
    global.fetch = async (url, peticion) => {
        const cuerpo = JSON.parse(peticion.body);
        modelos.push(cuerpo.model);
        assert.deepEqual(cuerpo.questions[0].choices, [{ value: true }, { value: 'true' }, { value: false }]);
        return respuesta({ answers: [{ type: 'choice', choice: false, confidence: 0.9 }] });
    };
    await api.procesarDecision('Hola', [true, 'true', false]);
    await api.procesarDecision('Hola', [true, 'true', false], { modelo: 'modelo-explicito' });
    assert.deepEqual(modelos, ['modelo-configurado', 'modelo-explicito']);
});
