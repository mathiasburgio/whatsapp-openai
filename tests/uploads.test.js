const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Module, createRequire } = require('node:module');

test('uploads entrega audio e imagen solo a usuarios habilitados', async t => {
    const audioNombre = `${randomUUID()}.ogg`;
    const imagenNombre = `${randomUUID()}.png`;
    const audioRuta = path.resolve(__dirname, '../uploads/audio', audioNombre);
    const imagenRuta = path.resolve(__dirname, '../uploads/imagenes', imagenNombre);
    await fsp.mkdir(path.dirname(audioRuta), { recursive: true });
    await fsp.mkdir(path.dirname(imagenRuta), { recursive: true });
    await fsp.writeFile(audioRuta, 'audio de prueba');
    await fsp.writeFile(imagenRuta, 'imagen de prueba');
    t.after(async () => {
        await fsp.unlink(audioRuta);
        await fsp.unlink(imagenRuta);
    });

    const filename = path.resolve(__dirname, '../index.js');
    const modulo = new Module(filename);
    const original = createRequire(filename);
    const mocks = {
        dotenv: { config() {} },
        './services/orquestador': {}, './services/mongo': {},
        './services/whatsapp': { configurarWebhook() {}, recibirMensajeWebhook() {} },
        './services/sockets': { inicializar() {} },
        './services/usuarios': { iniciarSesion() {}, cerrarSesion() {} },
        './models/usuarios': { exists: async ({ _id }) => _id === 'activo' },
        './middlewares/middlewareSession': (req, res, next) => { req.session = { usuarioId: req.headers['x-test-usuario'] }; next(); },
        './middlewares/tieneSesion': async (req, res, next) => {
            if (req.session.usuarioId !== 'activo') return res.status(401).json({ error: 'Iniciá sesión para continuar.' });
            next();
        },
    };
    modulo.require = nombre => Object.hasOwn(mocks, nombre) ? mocks[nombre] : original(nombre);
    modulo._compile(fs.readFileSync(filename, 'utf8').replace(/^iniciar\(\);\s*$/m, 'module.exports = app;'), filename);
    const servidor = modulo.exports.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { servidor.once('listening', resolve); servidor.once('error', reject); });
    t.after(() => new Promise(resolve => servidor.close(resolve)));
    const base = `http://127.0.0.1:${servidor.address().port}`;
    const pedir = async (ruta, usuario) => {
        const respuesta = await fetch(base + ruta, { headers: usuario ? { 'x-test-usuario': usuario } : {}, signal: AbortSignal.timeout(5000) });
        return { status: respuesta.status, headers: respuesta.headers, contenido: await respuesta.text() };
    };

    const audio = `/uploads/audio/${audioNombre}`;
    assert.equal((await pedir(audio)).status, 401);
    assert.equal((await pedir(audio, 'deshabilitado')).status, 401);
    const respuestaAudio = await pedir(audio, 'activo');
    assert.equal(respuestaAudio.status, 200);
    assert.equal(respuestaAudio.contenido, 'audio de prueba');
    assert.match(respuestaAudio.headers.get('content-type'), /audio\/ogg/);
    assert.match(respuestaAudio.headers.get('cache-control'), /no-store/);
    assert.equal(respuestaAudio.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await pedir(`/uploads/imagenes/${imagenNombre}`, 'activo')).contenido, 'imagen de prueba');
    assert.equal((await pedir('/uploads/audio/inexistente.ogg', 'activo')).status, 404);
});
