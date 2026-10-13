const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('el JSON abierto muestra las acciones recibidas por socket sin cambiar de mensaje ni reabrirse al cerrar', () => {
    const elementos = new Map();
    const $ = selector => {
        if (!elementos.has(selector)) elementos.set(selector, { contenido: '', eventos: {},
            on(evento, handler) { this.eventos[evento] = handler; return this; },
            text(valor) { if (!arguments.length) return this.contenido; this.contenido = valor; return this; },
        });
        return elementos.get(selector);
    };
    $.get = async () => false;
    const modal = { open: false, showModal() { this.open = true; }, close() {
        this.open = false; $('#modal-mensaje').eventos.close();
    } };
    const contexto = vm.createContext({ $, io: () => ({ on() {} }), document: { getElementById: () => modal } });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/index.js'), 'utf8'), contexto);
    vm.runInContext("conversacionActual = { _id: 'c1' }; mensajes = [{ _id: 'm1', conversacionId: 'c1', acciones: [] }]; listarMensajes = () => {}; mostrarDetalleMensaje('m1');", contexto);
    const recibir = vm.runInContext('recibirCambios', contexto);
    recibir({ mensaje: { _id: 'm1', conversacionId: 'c1', acciones: [{ accion: 'interpretar', estado: 'iniciada' }] } });
    assert.equal(modal.open, true);
    assert.equal(JSON.parse($('#mensaje-json').text()).acciones[0].estado, 'iniciada');
    recibir({ mensaje: { _id: 'm2', conversacionId: 'c1', acciones: [] } });
    assert.equal(JSON.parse($('#mensaje-json').text())._id, 'm1');
    recibir({ mensaje: { _id: 'm1', conversacionId: 'c1', acciones: [{ accion: 'responder', estado: 'ok', detalle: { whatsappId: 'wamid.1' } }] } });
    assert.equal(JSON.parse($('#mensaje-json').text()).acciones[0].detalle.whatsappId, 'wamid.1');
    modal.close();
    recibir({ mensaje: { _id: 'm1', conversacionId: 'c1', acciones: [] } });
    assert.equal(modal.open, false);
    assert.equal($('#mensaje-json').text(), '');
});
