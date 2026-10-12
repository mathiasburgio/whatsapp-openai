const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('el interruptor usa la ruta específica para habilitar o deshabilitar el bot', async () => {
    const elementos = new Map();
    const $ = selector => {
        if (!elementos.has(selector)) elementos.set(selector, { propiedades: {}, on() { return this; },
            prop(nombre, valor) {
                if (arguments.length === 1) return this.propiedades[nombre];
                this.propiedades[nombre] = valor;
                return this;
            } });
        return elementos.get(selector);
    };
    const rutas = [];
    $.get = async () => false;
    $.post = async opciones => {
        rutas.push({ url: opciones.url, body: JSON.parse(opciones.data) });
        return { _id: 'abc', botActivo: opciones.url.endsWith('/habilitar-bot') };
    };
    const contexto = vm.createContext({ $, io: () => ({ on() {} }) });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/index.js'), 'utf8'), contexto);
    vm.runInContext("conversaciones = [{ _id: 'abc', botActivo: false }]; conversacionActual = conversaciones[0]; actualizarControlBot = () => {}; recibirCambios = () => {};", contexto);

    $('#bot-activo').prop('checked', true);
    await vm.runInContext('cambiarEstadoBot()', contexto);
    $('#bot-activo').prop('checked', false);
    await vm.runInContext('cambiarEstadoBot()', contexto);
    assert.deepEqual(rutas, [
        { url: '/conversaciones/habilitar-bot', body: { conversacionId: 'abc' } },
        { url: '/conversaciones/deshabilitar-bot', body: { conversacionId: 'abc' } },
    ]);
});

test('el panel bloquea un segundo envío mientras espera la confirmación', async () => {
    const elementos = new Map();
    const obtener = selector => {
        if (!elementos.has(selector)) elementos.set(selector, { propiedades: {}, valor: '', on() { return this; },
            prop(nombre, valor) {
                if (arguments.length === 1) return this.propiedades[nombre];
                this.propiedades[nombre] = valor;
                return this;
            },
            val(valor) {
                if (arguments.length === 0) return this.valor;
                this.valor = valor;
                return this;
            } });
        return elementos.get(selector);
    };
    const $ = selector => selector.includes(',') ? {
        prop(nombre, valor) { selector.split(',').forEach(parte => obtener(parte.trim()).prop(nombre, valor)); return this; },
        on() { return this; },
    } : obtener(selector);
    $.get = async () => false;
    const envios = [];
    const socket = { connected: true, on() {}, timeout() { return this; }, emit(evento, datos, responder) {
        envios.push({ evento, datos, responder });
    } };
    const contexto = vm.createContext({ $, io: () => socket, Swal: { fire() {} } });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/index.js'), 'utf8'), contexto);
    vm.runInContext("conversaciones = [{ _id: 'c1' }]; conversacionActual = conversaciones[0]; listarConversaciones = () => {}; recibirCambios = () => {};", contexto);
    $('#texto-mensaje').val('Hola');
    const primero = vm.runInContext('enviarMensaje()', contexto);
    await vm.runInContext('enviarMensaje()', contexto);
    assert.equal(envios.length, 1);
    assert.equal(envios[0].evento, 'enviar-mensaje');
    assert.equal(envios[0].datos.contenido, 'Hola');
    assert.equal(Object.hasOwn(envios[0].datos, 'solicitudId'), false);
    assert.equal($('#texto-mensaje').prop('disabled'), true);
    assert.equal($('#btn-enviar-mensaje').prop('disabled'), true);
    envios[0].responder(null, { mensaje: { _id: 'm1', conversacionId: 'c1', contenido: 'Hola', fechaEmitida: new Date().toISOString() } });
    await primero;
    assert.equal($('#texto-mensaje').val(), '');
    assert.equal($('#texto-mensaje').prop('disabled'), false);
    assert.equal($('#btn-enviar-mensaje').prop('disabled'), false);
});
