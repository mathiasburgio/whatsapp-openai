const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const vm = require('node:vm');
const mongoose = require('mongoose');
const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');

function cargarServicio(nombre, mocks) {
    const filename = path.join(__dirname, '..', 'services', `${nombre}.js`);
    const isolatedModule = new Module(filename);
    const original = createRequire(filename);
    isolatedModule.require = name => Object.hasOwn(mocks, name) ? mocks[name] : original(name);
    isolatedModule._compile(fs.readFileSync(filename, 'utf8'), filename);
    return isolatedModule.exports;
}

test('sockets comparte la sesión, valida conexiones y envíos, y filtra el broadcast', async () => {
    let io;
    class Server {
        constructor(server, options) {
            io = this;
            this.options = options;
            this.engine = { use: middleware => { this.middlewareSesion = middleware; } };
            this.sockets = { sockets: new Map() };
        }
        use(middleware) { this.autenticar = middleware; }
        on(evento, handler) { this.conectar = handler; }
    }
    const usuarioId = new mongoose.Types.ObjectId().toString();
    const conversacionId = new mongoose.Types.ObjectId().toString();
    const enviados = [];
    const sockets = cargarServicio('sockets', {
        'socket.io': { Server },
        '../models/usuarios': { exists: async ({ _id, habilitado }) => _id === usuarioId && habilitado },
        './orquestador': {
            responderMensajePorApiWhataspp: async (id, contenido) => {
                enviados.push({ id, contenido });
                return { _id: 'mensaje1', conversacionId: id, contenido };
            },
        },
    });
    const middlewareSesion = () => {};
    sockets.inicializar({}, middlewareSesion);
    assert.equal(io.middlewareSesion, middlewareSesion);

    function crearSocket(id = usuarioId) {
        const handlers = {};
        const socket = {
            request: { session: { usuarioId: id, reload: callback => callback() } },
            on: (evento, handler) => { handlers[evento] = handler; },
            emit: (evento, datos) => socket.eventos.push({ evento, datos }),
            disconnect: () => { socket.desconectado = true; },
            eventos: [], handlers,
        };
        return socket;
    }
    const autorizado = crearSocket();
    const anonimo = crearSocket(null);
    const deshabilitado = crearSocket(new mongoose.Types.ObjectId().toString());
    const autenticar = socket => new Promise(resolve => io.autenticar(socket, resolve));
    assert.equal(await autenticar(autorizado), undefined);
    assert.equal((await autenticar(anonimo)).data.sesionInactiva, true);
    assert.equal((await autenticar(deshabilitado)).data.sesionInactiva, true);
    const comprobarOrigen = headers => new Promise(resolve => io.options.allowRequest({ headers }, (error, permitido) => resolve(permitido)));
    assert.equal(await comprobarOrigen({ host: 'localhost:3000', origin: 'http://localhost:3000' }), true);
    assert.equal(await comprobarOrigen({ host: 'localhost:3000', origin: 'https://otro.example' }), false);
    assert.equal(await comprobarOrigen({ host: 'localhost:3000', origin: 'invalido' }), false);

    io.conectar(autorizado);
    const enviar = datos => new Promise(resolve => autorizado.handlers['enviar-mensaje'](datos, resolve));
    assert((await enviar({ conversacionId: 'invalido', contenido: 'Hola' })).error);
    assert((await enviar({ conversacionId, contenido: ' ' })).error);
    assert((await enviar(null)).error);
    assert((await enviar({ conversacionId, contenido: 'x'.repeat(4097) })).error);
    assert.equal(enviados.length, 0);
    assert.equal((await enviar({ conversacionId, contenido: ' Hola ' })).mensaje.contenido, 'Hola');
    assert.deepEqual(enviados, [{ id: conversacionId, contenido: 'Hola' }]);

    io.sockets.sockets.set('autorizado', autorizado);
    io.sockets.sockets.set('deshabilitado', deshabilitado);
    const vencido = crearSocket();
    vencido.request.session.reload = callback => callback(new Error('Sesión eliminada'));
    io.sockets.sockets.set('vencido', vencido);
    await sockets.notificarCambios({ _id: conversacionId }, { contenido: 'Hola' });
    assert.equal(autorizado.eventos[0].evento, 'cambios');
    assert.equal(deshabilitado.eventos.length, 0);
    assert.equal(deshabilitado.desconectado, true);
    assert.equal(vencido.eventos.length, 0);
    assert.equal(vencido.desconectado, true);

    autorizado.request.session.reload = callback => callback(new Error('Sesión eliminada'));
    assert.equal((await enviar({ conversacionId, contenido: 'No enviar' })).sesionInactiva, true);
    assert.equal(autorizado.desconectado, true);
    assert.equal(enviados.length, 1);
});

test('el orquestador guarda el mensaje del vendedor y notifica después de persistir la conversación', async () => {
    const id = new mongoose.Types.ObjectId();
    const conversacion = new Conversacion({
        _id: id, telefono: '5491112345678', botActivo: true,
        ultimoMensaje: { deClienteParaSistema: true, emisor: '5491112345678', receptor: '5491198765432' },
    });
    const pasos = [];
    const mensajes = [];
    conversacion.save = async () => { pasos.push('conversacion'); };
    const orquestador = cargarServicio('orquestador', {
        '../models/conversacion': { findById: async () => conversacion, findOneAndUpdate: async (_, update) => {
            Object.assign(conversacion, update.$set); pasos.push(update.$set.ultimoMensaje ? 'conversacion' : 'pausa'); return conversacion;
        }, updateOne: async () => {} },
        '../models/mensaje': {
            findOne: () => ({ sort: async () => ({ receptor: '5491198765432', mediaPhoneNumberId: 'numero-test' }) }),
            create: async datos => { pasos.push('mensaje'); const mensaje = new Mensaje(datos); mensaje.save = async () => mensaje; mensajes.push(mensaje); return mensaje; },
        },
        './whatsapp': { enviarMensaje: async datos => {
            assert.equal(datos.to, conversacion.telefono);
            assert.equal(datos.phoneNumberId, 'numero-test');
            pasos.push('whatsapp');
            return { messages: [{ id: 'wamid.test.' + (mensajes.length + 1) }] };
        } },
        './envios': { serializar: require('../services/envios').serializar, verificarLimiteMensual: async () => {} },
        './sockets': { notificarCambios: async (actual, mensaje) => {
            pasos.push('broadcast');
            assert.equal(actual.ultimoMensaje._id.toString(), mensaje._id.toString());
        } },
    });
    let numero = 0;
    for (const contenido of ['Primera respuesta', 'Segunda respuesta']) {
        numero++;
        const mensaje = await orquestador.responderMensajePorApiWhataspp(id.toString(), contenido);
        assert.equal(mensaje.emisor, '5491198765432');
        assert.equal(mensaje.receptor, conversacion.telefono);
        assert.equal(mensaje.deSistemaParaCliente, true);
        assert.equal(conversacion.ultimoMensaje.contenido, contenido);
        assert.equal(conversacion.ultimoMensaje.crudo.messages[0].id, 'wamid.test.' + numero);
        assert.equal(mensaje.whatsappId, 'wamid.test.' + numero);
        assert.equal(mensaje.respuestaAutomatica, false);
        assert(mensaje.fechaEmitida instanceof Date);
        assert.equal(conversacion.botActivo, true);
        assert.equal(conversacion.deClienteParaSistema, false);
    }
    assert.deepEqual(pasos, ['whatsapp', 'mensaje', 'conversacion', 'broadcast', 'whatsapp', 'mensaje', 'conversacion', 'broadcast']);
});

test('el panel no duplica el mensaje al recibir el broadcast y la confirmación', async () => {
    const jquery = () => ({ on() {} });
    jquery.get = async () => false;
    const socket = { on() {}, connected: true, timeout() { return this; },
        emit(evento, datos, responder) { responder(null, { mensaje: { _id: 'm1', ...datos } }); } };
    const context = vm.createContext({ $: jquery, io: () => socket });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.js'), 'utf8'), context);
    vm.runInContext(`
        listarConversaciones = () => {};
        listarMensajes = () => {};
        actualizarControlBot = () => {};
        conversaciones = [{ _id: 'c1', nombre: 'Cliente' }];
        conversacionActual = conversaciones[0];
    `, context);
    const recibirCambios = vm.runInContext('recibirCambios', context);
    const enviar = vm.runInContext('enviarPorSocket', context);
    recibirCambios({ conversacion: { _id: 'c1', nombre: 'Nombre actualizado' }, mensaje: { _id: 'm1', conversacionId: 'c1', contenido: 'Hola' } });
    recibirCambios({ mensaje: await enviar('c1', 'Hola') });
    assert.equal(vm.runInContext('mensajes.length', context), 1);
    assert.equal(vm.runInContext('conversacionActual.nombre', context), 'Nombre actualizado');
    recibirCambios({ mensaje: { _id: 'm2', conversacionId: 'c2', contenido: 'Otro chat' } });
    assert.equal(vm.runInContext('mensajes.length', context), 1);
    socket.connected = false;
    await assert.rejects(enviar('c1', 'Hola'), /No hay conexión/);
});
