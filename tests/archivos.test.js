const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Module, createRequire } = require('node:module');

function cargar(filename, mocks, fuente = fs.readFileSync(filename, 'utf8')) {
    const modulo = new Module(filename);
    const original = createRequire(filename);
    modulo.require = nombre => Object.hasOwn(mocks, nombre) ? mocks[nombre] : original(nombre);
    modulo._compile(fuente, filename);
    return modulo.exports;
}

test('el panel entrega media solo con sesión habilitada, admite rangos y conserva archivos anteriores', async t => {
    const carpeta = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatsapp-media-test-'));
    t.after(() => fsp.rm(carpeta, { recursive: true, force: true }));
    const audioId = '507f1f77bcf86cd799439011', imagenId = '507f1f77bcf86cd799439012';
    let descargas = 0, guardados = 0;
    const documentos = {
        [audioId]: { _id: audioId, esAudio: true, crudo: { audio: { id: 'audio-meta' } }, mediaPhoneNumberId: 'numero-meta' },
        [imagenId]: { _id: imagenId, esImagen: true, crudo: { image: { id: 'imagen-meta' } } },
    };
    for (const mensaje of Object.values(documentos)) mensaje.save = async () => { guardados++; };
    const filename = path.resolve(__dirname, '../services/archivos.js');
    const archivos = cargar(filename, {
        '../models/mensaje': { findById: async id => documentos[id] },
        './whatsapp': { descargarMedia: async (id, opciones) => {
            descargas++;
            if (id === 'audio-meta') {
                assert.equal(opciones.phoneNumberId, 'numero-meta');
                return { buffer: Buffer.from('0123456789'), mimeType: 'audio/ogg; codecs=opus' };
            }
            return { buffer: Buffer.from('imagen'), mimeType: 'image/png' };
        } },
    }, fs.readFileSync(filename, 'utf8').replace("path.resolve(__dirname, '../uploads')", JSON.stringify(carpeta)));
    const entrada = path.resolve(__dirname, '../index.js');
    const app = cargar(entrada, {
        dotenv: { config() {} },
        './services/archivos': archivos, './services/orquestador': {}, './services/mongo': {},
        './services/whatsapp': { configurarWebhook() {}, recibirMensajeWebhook() {} },
        './services/sockets': { inicializar() {} },
        './services/usuarios': { iniciarSesion() {}, cerrarSesion() {} },
        './models/usuarios': { exists: async ({ _id }) => _id === 'activo' },
        'express-session': () => (req, res, next) => { req.session = { usuarioId: req.headers['x-test-usuario'] }; next(); },
    }, fs.readFileSync(entrada, 'utf8').replace(/^iniciar\(\);\s*$/m, 'module.exports = app;'));
    const servidor = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { servidor.once('listening', resolve); servidor.once('error', reject); });
    t.after(() => new Promise(resolve => servidor.close(resolve)));
    const base = `http://127.0.0.1:${servidor.address().port}`;
    async function pedir(ruta, headers = { 'x-test-usuario': 'activo' }) {
        const respuesta = await fetch(base + ruta, { headers, signal: AbortSignal.timeout(5000) });
        return { status: respuesta.status, headers: respuesta.headers, contenido: await respuesta.text() };
    }
    const audio = `/mensajes/${audioId}/media/audio`;
    assert.equal((await pedir(audio, {})).status, 401);
    assert.equal((await pedir(audio, { 'x-test-usuario': 'deshabilitado' })).status, 401);
    assert.equal(descargas, 0);
    const simultaneos = await Promise.all([pedir(audio), pedir(audio)]);
    for (const respuesta of simultaneos) {
        assert.equal(respuesta.status, 200);
        assert.equal(respuesta.contenido, '0123456789');
        assert.equal(respuesta.headers.get('content-type'), 'audio/ogg');
        assert.match(respuesta.headers.get('cache-control'), /private/);
        assert.equal(respuesta.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal(descargas, 1);
    assert.equal(guardados, 1);
    const parcial = await pedir(audio, { 'x-test-usuario': 'activo', Range: 'bytes=2-5' });
    assert.equal(parcial.status, 206);
    assert.equal(parcial.contenido, '2345');
    assert.equal(parcial.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(descargas, 1);
    const imagen = await pedir(`/mensajes/${imagenId}/media/imagen`);
    assert.equal(imagen.status, 200);
    assert.equal(imagen.headers.get('content-type'), 'image/png');
    assert.equal((await pedir('/mensajes/invalido/media/audio')).status, 400);
    assert.equal((await pedir(`/mensajes/${audioId}/media/otro`)).status, 400);
    assert.equal((await pedir(`/mensajes/${audioId}/media/imagen`)).status, 404);
    assert.equal((await pedir('/mensajes/507f1f77bcf86cd799439099/media/audio')).status, 404);
});

test('rechaza formatos ejecutables sin persistirlos ni publicar rutas arbitrarias', async t => {
    const filename = path.resolve(__dirname, '../services/archivos.js');
    const archivos = cargar(filename, {
        '../models/mensaje': {},
        './whatsapp': { descargarMedia: async () => ({ buffer: Buffer.from('<svg/>'), mimeType: 'image/svg+xml' }) },
    });
    const mensaje = { _id: 'no-compatible', imagenArchivo: '../../secreto.txt', imagenMimeType: 'image/png',
        save: () => assert.fail('No guarda archivos no compatibles') };
    await assert.rejects(archivos.obtenerMedia(mensaje, 'imagen', { id: 'meta' }), /formato no compatible/);
    assert.equal(mensaje.imagenArchivo, '../../secreto.txt');
});
