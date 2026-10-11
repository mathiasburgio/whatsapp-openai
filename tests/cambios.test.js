const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module } = require('node:module');
const { EventEmitter } = require('node:events');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Usuario = require('../models/usuarios');
const usuarios = require('../services/usuarios');
const Conversacion = require('../models/conversacion');

test('rehabilitar conserva la contraseña o la reemplaza si se proporciona', async t => {
    const originalFindOne = Usuario.findOne;
    const originalCreate = Usuario.create;
    t.after(() => { Usuario.findOne = originalFindOne; Usuario.create = originalCreate; });
    const hashAnterior = await bcrypt.hash('Anterior123', 4);
    let guardados = 0;
    const existente = { habilitado: false, contrasena: hashAnterior, save: async () => { guardados++; } };
    Usuario.findOne = async () => existente;
    assert.equal((await usuarios.nuevo(' Persona@example.com ')).accion, 'habilitado');
    assert.equal(existente.contrasena, hashAnterior);
    assert.equal(existente.habilitado, true);

    existente.habilitado = false;
    assert.equal((await usuarios.nuevo('persona@example.com', 'Nueva123')).accion, 'habilitado');
    assert(await bcrypt.compare('Nueva123', existente.contrasena));
    assert(!await bcrypt.compare('Anterior123', existente.contrasena));
    assert.equal(bcrypt.getRounds(existente.contrasena), 12);
    const hashNuevo = existente.contrasena;
    assert.equal((await usuarios.nuevo('persona@example.com', 'Otra123')).accion, 'existente');
    assert.equal(existente.contrasena, hashNuevo);
    assert.equal(guardados, 2);
    await assert.rejects(usuarios.nuevo('persona@example.com', ''), /contraseña/);

    Usuario.findOne = async () => null;
    let creado;
    Usuario.create = async datos => { creado = datos; };
    await assert.rejects(usuarios.nuevo('persona@example.com'), /contraseña/);
    assert.equal(creado, undefined);
    assert.equal((await usuarios.nuevo(' Persona@example.com ', 'Nueva123')).accion, 'creado');
    assert.equal(creado.email, 'persona@example.com');
    assert(await bcrypt.compare('Nueva123', creado.contrasena));
});

test('el login limita intentos y las rutas usan la nueva conversación', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const conversacion = new Conversacion({
        _id: id, telefono: '5491112345678',
        intereses: [{ vehiculo: { marca: 'Honda' }, lead: 'caliente' }],
        ultimoMensaje: { deClienteParaSistema: true, emisor: '5491112345678', receptor: '5491198765432', contenido: 'Hola' },
    });
    await conversacion.validate();
    assert.equal(conversacion.toObject().ultimoMensaje.contenido, 'Hola');
    assert.equal(conversacion.toObject().intereses[0].vehiculo.marca, 'Honda');
    assert(Conversacion.schema.indexes().some(([keys]) => keys.telefono === 1 && keys.updatedAt === -1));
    let loginCalls = 0, query;
    const mocks = {
        './services/whatsapp': {
            recibirMensajeWebhook() {}, configurarWebhook() {},
        },
        './services/orquestador': {}, './services/mongo': {},
        './services/sockets': { inicializar() {} },
        './services/usuarios': {
            iniciarSesion: (req, res) => { loginCalls++; res.json({ sesionActiva: true }); }, cerrarSesion() {},
        },
        './models/usuarios': { exists: async () => true },
        './models/conversacion': {
            find: filtro => { query = filtro; return { sort: () => ({ limit: async () => [conversacion] }) }; },
        },
        './models/mensaje': {},
        dotenv: { config() {} }, fs: { existsSync: () => true },
    };
    const root = path.join(__dirname, '..');
    const filename = path.join(root, 'index.js');
    const source = fs.readFileSync(filename, 'utf8').replace(/^iniciar\(\);\s*$/m, 'module.exports = app;');
    const isolatedModule = new Module(filename);
    isolatedModule.filename = filename;
    isolatedModule.require = name => Object.hasOwn(mocks, name) ? mocks[name] : require(name);
    isolatedModule._compile(source, filename);
    const app = isolatedModule.exports;

    function request(url, method = 'GET', body = {}, ip = '127.0.0.1') {
        return new Promise((resolve, reject) => {
            const req = { app, method, url, body, ip, headers: {}, socket: { remoteAddress: ip }, query: { noLeidas: 'true' }, session: { usuarioId: id }, get: () => undefined };
            const res = new EventEmitter();
            res.statusCode = 200;
            const headers = {};
            res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
            res.getHeader = name => headers[name.toLowerCase()];
            res.append = (name, value) => { const key = name.toLowerCase(); headers[key] = headers[key] ? `${headers[key]}, ${value}` : value; return res; };
            res.status = status => { res.statusCode = status; return res; };
            res.json = res.send = value => { res.emit('finish'); resolve({ status: res.statusCode, headers, body: value }); return res; };
            const route = app.router.stack.find(layer => layer.route?.path === url && layer.route.methods[method.toLowerCase()]).route;
            route.dispatch(req, res, reject);
        });
    }

    for (let i = 0; i < 5; i++) {
        const response = await request('/iniciar-sesion', 'POST');
        assert.equal(response.status, 200);
        assert(response.headers.ratelimit);
    }
    const blocked = await request('/iniciar-sesion', 'POST');
    assert.equal(blocked.status, 429);
    assert(Number(blocked.headers['retry-after']) > 0);
    assert.match(blocked.body.error, /Demasiados intentos/);
    assert.equal(loginCalls, 5);
    assert.equal((await request('/iniciar-sesion', 'POST', {}, '127.0.0.2')).status, 200);
    for (let i = 0; i < 6; i++) assert.equal((await request('/verificar-sesion')).status, 200);
    assert.equal((await request('/conversaciones')).status, 200);
    assert.equal(JSON.stringify(query), JSON.stringify({ 'ultimoMensaje.deClienteParaSistema': true, 'ultimoMensaje.fechaLeida': null }));
});
