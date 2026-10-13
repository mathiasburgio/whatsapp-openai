const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('el listado prioriza vendedores sobre fechas y la vista sin responder conserva las derivaciones', () => {
    const elementos = new Map();
    const $ = selector => {
        if (!elementos.has(selector)) elementos.set(selector, { contenido: '', valor: '', on() { return this; },
            val() { return this.valor; }, html(valor) { this.contenido = valor; return this; } });
        return elementos.get(selector);
    };
    $.get = async () => false;
    const context = vm.createContext({ $, io: () => ({ on() {} }) });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/index.js'), 'utf8'), context);
    vm.runInContext(`actualizarControlBot = () => {}; conversaciones = [
        {_id:'reciente',nombre:'Cliente reciente',updatedAt:'2026-10-11',ultimoMensaje:{deClienteParaSistema:true}},
        {_id:'respondida',nombre:'Ya respondida',updatedAt:'2026-10-10',ultimoMensaje:{deSistemaParaCliente:true}},
        {_id:'vendedor',nombre:'Necesita vendedor',updatedAt:'2026-01-01',accionesExternasRequeridas:[{_id:'a1',detalle:'Evaluar usada',aceptada:false}],ultimoMensaje:{deSistemaParaCliente:true}},
    ]; listarConversaciones();`, context);
    const html = $('#lista-conversaciones').contenido;
    assert(html.indexOf('Necesita vendedor') < html.indexOf('Cliente reciente'));
    assert.match(html, /requiere-vendedor/);
    vm.runInContext(`modoListado='pendientes'; listarConversaciones();`, context);
    const pendientes = $('#lista-conversaciones').contenido;
    assert(pendientes.includes('Necesita vendedor'));
    assert(pendientes.includes('Cliente reciente'));
    assert(!pendientes.includes('Ya respondida'));
    vm.runInContext(`recibirCambios({conversacion:{_id:'reciente',accionesExternasRequeridas:[{_id:'a2',detalle:'Confirmar financiación',aceptada:false}],updatedAt:'2026-10-11'}});`, context);
    assert($('#lista-conversaciones').contenido.indexOf('Cliente reciente') < $('#lista-conversaciones').contenido.indexOf('Necesita vendedor'));
});
