const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const crypto = require('node:crypto');

function cargar(filename, mocks, source = fs.readFileSync(filename, 'utf8')) {
    const modulo = new Module(filename);
    modulo.filename = filename;
    modulo.paths = Module._nodeModulePaths(path.dirname(filename));
    const requireOriginal = createRequire(filename);
    modulo.require = nombre => Object.hasOwn(mocks, nombre) ? mocks[nombre] : requireOriginal(nombre);
    modulo._compile(source, filename);
    return modulo.exports;
}

test('las rutas HTTP del webhook verifican GET y reciben POST firmado sin login', async t => {
    const variables = ['WEBHOOK_VERIFY_TOKEN', 'SESSION_SECRET', 'WHATSAPP_APP_SECRET'];
    const entorno = variables.map(nombre => [nombre, process.env[nombre]]);
    t.after(() => {
        for (const [nombre, valor] of entorno) {
            if (valor === undefined) delete process.env[nombre];
            else process.env[nombre] = valor;
        }
    });
    process.env.WEBHOOK_VERIFY_TOKEN = 'token-de-prueba-local';
    process.env.SESSION_SECRET = 'secreto-de-prueba-local';
    process.env.WHATSAPP_APP_SECRET = 'secreto-meta-de-prueba';
    const root = path.resolve(__dirname, '..');
    const recibidos = [];
    t.mock.method(console, 'log', () => {});
    const whatsapp = cargar(path.join(root, 'services/whatsapp.js'), {
        './orquestador': { recibirMensajeWhatsapp: async (...args) => recibidos.push(args) },
    });
    const filename = path.join(root, 'index.js');
    const source = fs.readFileSync(filename, 'utf8').replace(/^iniciar\(\);\s*$/m, 'module.exports = app;');
    const app = cargar(filename, {
        dotenv: { config() {} }, fs: { existsSync: () => true },
        './services/whatsapp': whatsapp,
        './services/mongo': { connectDB: () => assert.fail('La prueba no debe conectarse a MongoDB') },
        './services/sockets': { inicializar() {} },
        './services/orquestador': {},
    }, source);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}/whatsapp/webhook`;
    const parametros = { 'hub.mode': 'subscribe', 'hub.verify_token': 'token-de-prueba-local', 'hub.challenge': '00123456789' };
    const respuesta = await fetch(`${url}?${new URLSearchParams(parametros)}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(respuesta.status, 200);
    assert.equal(await respuesta.text(), '00123456789');
    assert.equal(respuesta.headers.get('set-cookie'), null);
    for (const query of [
        { ...parametros, 'hub.verify_token': 'incorrecto' },
        { ...parametros, 'hub.mode': 'otro' },
        { ...parametros, 'hub.verify_token': '' },
        {},
    ]) {
        const rechazo = await fetch(`${url}?${new URLSearchParams(query)}`, { signal: AbortSignal.timeout(5000) });
        assert.equal(rechazo.status, 403);
        await rechazo.text();
    }
    assert.equal(recibidos.length, 0);
    // Los espacios permiten comprobar que la firma usa el cuerpo original y no JSON reserializado.
    const body = '{ "entry": [{ "changes": [{ "field": "messages", "value": { "messages": [{ "from": "5491112345678", "id": "wamid.http", "type": "text", "text": { "body": "Hola por HTTP" } }] } }] }] }';
    const firma = `sha256=${crypto.createHmac('sha256', 'secreto-meta-de-prueba').update(body).digest('hex')}`;
    const post = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': firma }, body,
        signal: AbortSignal.timeout(5000) });
    assert.equal(post.status, 200);
    await post.text();
    assert.equal(recibidos.length, 1);
    assert.equal(recibidos[0][1], 'Hola por HTTP');
    const invalido = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
    assert.equal(invalido.status, 401);
    await invalido.text();
    assert.equal(recibidos.length, 1);
});

function prepararWhatsapp(t, orquestador = {}, modeloMensaje = { findOneAndUpdate: async () => null }) {
    const nombres = ['WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_GRAPH_API_URL'];
    const originales = nombres.map(nombre => [nombre, process.env[nombre]]);
    t.after(() => {
        for (const [nombre, valor] of originales) {
            if (valor === undefined) delete process.env[nombre];
            else process.env[nombre] = valor;
        }
    });
    process.env.WHATSAPP_APP_SECRET = 'secreto-meta-de-prueba';
    process.env.WHATSAPP_ACCESS_TOKEN = 'token-meta-de-prueba';
    process.env.WHATSAPP_GRAPH_API_URL = 'https://graph.facebook.com';
    const logs = [], errores = [];
    t.mock.method(console, 'log', (...args) => logs.push(args));
    t.mock.method(console, 'error', (...args) => errores.push(args));
    return { api: cargar(path.resolve(__dirname, '../services/whatsapp.js'), {
        './orquestador': orquestador, '../models/mensaje': modeloMensaje,
    }), logs, errores };
}

function solicitud(cuerpo) {
    const rawBody = Buffer.from(JSON.stringify(cuerpo));
    const firma = `sha256=${crypto.createHmac('sha256', 'secreto-meta-de-prueba').update(rawBody).digest('hex')}`;
    return { body: cuerpo, rawBody, get: () => firma };
}

test('el webhook confirma antes de procesar y deriva mensajes y estados por separado', async t => {
    const llamadas = [], estados = [], notificaciones = [];
    const { api, logs } = prepararWhatsapp(t, { recibirMensajeWhatsapp: async (...args) => {
        assert.deepEqual(estados, [200]);
        llamadas.push(args);
    } }, { findOneAndUpdate: async filtro => {
        assert.deepEqual(estados, [200]);
        notificaciones.push(filtro.whatsappId);
        return null;
    } });
    const imagen = { id: 'imagen-1', mime_type: 'image/jpeg', caption: '¿Qué moto es?' };
    const audio = { id: 'audio-1', mime_type: 'audio/ogg; codecs=opus' };
    const mensaje = { id: 'wamid.1', from: '5491112345678', timestamp: '1700000000', type: 'text', text: { body: 'Hola' } };
    await api.recibirMensajeWebhook(solicitud({ entry: [{ changes: [
        { field: 'messages', value: { metadata: { display_phone_number: '5491198765432', phone_number_id: 'numero-1' },
            contacts: [{ wa_id: mensaje.from, profile: { name: 'Cliente' } }],
            messages: [mensaje, { ...mensaje, id: 'wamid.2', type: 'image', image: imagen },
                { ...mensaje, id: 'wamid.3', type: 'audio', audio }] } },
        { field: 'messages', value: { statuses: [{ id: 'wamid.1', status: 'delivered', timestamp: '1700000001' }] } },
        { field: 'otro', value: { messages: [mensaje] } },
    ] }, { changes: [{ field: 'messages', value: { messages: [{ ...mensaje, id: 'wamid.4' }] } }] }] }), {
        sendStatus: estado => estados.push(estado),
    });
    assert.equal(llamadas.length, 4);
    assert.deepEqual(notificaciones, ['wamid.1']);
    assert.deepEqual(llamadas[0].slice(0, 4), ['5491112345678', 'Hola', undefined, undefined]);
    assert.equal(llamadas[0][4].nombre, 'Cliente');
    assert.equal(llamadas[0][4].receptor, '5491198765432');
    assert.equal(llamadas[0][4].phoneNumberId, 'numero-1');
    assert.equal(llamadas[0][4].fechaEmitida.toISOString(), '2023-11-14T22:13:20.000Z');
    assert.equal(llamadas[0][4].crudo, mensaje);
    assert.deepEqual(llamadas[1].slice(0, 4), ['5491112345678', '¿Qué moto es?', imagen, undefined]);
    assert.deepEqual(llamadas[2].slice(0, 4), ['5491112345678', '', undefined, audio]);
    assert.equal(logs.filter(args => args[0] === 'Mensaje entrante de WhatsApp:').length, 0);
});

test('el webhook responde a firmas inválidas y captura fallos sin omitir el siguiente mensaje', async t => {
    let llamadas = 0;
    const { api, errores } = prepararWhatsapp(t, { recibirMensajeWhatsapp: async () => {
        if (++llamadas === 1) throw new Error('Falló MongoDB');
    } });
    const estados = [];
    const res = { sendStatus: estado => estados.push(estado) };
    const payload = { entry: [{ changes: [{ field: 'messages', value: { messages: [
        { id: 'uno', from: '5491112345678', type: 'text', text: { body: 'Uno' } },
        { id: 'dos', from: '5491112345678', type: 'text', text: { body: 'Dos' } },
    ] } }] }] };
    for (const firma of [undefined, 'sha256=invalida', `sha256=${'0'.repeat(64)}`]) {
        await api.recibirMensajeWebhook({ ...solicitud(payload), get: () => firma }, res);
    }
    assert.deepEqual(estados, [401, 401, 401]);
    assert.equal(llamadas, 0);
    await api.recibirMensajeWebhook({ ...solicitud(payload), rawBody: undefined }, res);
    assert.equal(estados.at(-1), 400);
    await api.recibirMensajeWebhook(solicitud(payload), res);
    assert.equal(estados.at(-1), 200);
    assert.equal(llamadas, 2);
    assert.equal(errores[0][1].error, 'Falló MongoDB');
    delete process.env.WHATSAPP_APP_SECRET;
    const sinSecreto = cargar(path.resolve(__dirname, '../services/whatsapp.js'), { './orquestador': {} });
    await sinSecreto.recibirMensajeWebhook(solicitud(payload), res);
    assert.equal(estados.at(-1), 503);
});

test('la descarga obtiene la URL de Meta, autentica ambos pasos y limita el tamaño', async t => {
    const { api } = prepararWhatsapp(t);
    const llamadas = [];
    t.mock.method(global, 'fetch', async (url, opciones) => {
        llamadas.push({ url: String(url), opciones });
        return llamadas.length === 1
            ? new Response(JSON.stringify({ url: 'https://media.example.com/archivo', mime_type: 'audio/ogg; codecs=opus', file_size: 3 }))
            : new Response(Buffer.from('abc'));
    });
    const archivo = await api.obtenerMediaDesdeWhatsapp('media-1', { phoneNumberId: 'numero-1', maxBytes: 3 });
    assert.equal(new URL(llamadas[0].url).searchParams.get('phone_number_id'), 'numero-1');
    assert.match(new URL(llamadas[0].url).pathname, /\/media-1$/);
    assert.equal(llamadas[1].url, 'https://media.example.com/archivo');
    assert(llamadas.every(llamada => llamada.opciones.headers.Authorization === 'Bearer token-meta-de-prueba'));
    assert.deepEqual(archivo, { buffer: Buffer.from('abc'), mimeType: 'audio/ogg' });
    llamadas.length = 0;
    await assert.rejects(api.obtenerMediaDesdeWhatsapp('media-1', { maxBytes: 2 }), /tamaño/);
    assert.equal(llamadas.length, 1);
    llamadas.length = 0;
    t.mock.method(global, 'fetch', async () => {
        llamadas.push(1);
        return llamadas.length === 1 ? new Response(JSON.stringify({ url: 'https://media.example.com/archivo' })) : new Response('abcd');
    });
    await assert.rejects(api.obtenerMediaDesdeWhatsapp('media-1', { maxBytes: 3 }), /tamaño/);
});
