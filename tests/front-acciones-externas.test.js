const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('el panel cierra una intervención por ID y conserva las otras y el bot activo', async () => {
    const elementos = new Map();
    const $ = selector => {
        if (!elementos.has(selector)) elementos.set(selector, { propiedades: {}, atributos: {}, contenido: '',
            on() { return this; },
            prop(nombre, valor) { if (arguments.length === 1) return this.propiedades[nombre]; this.propiedades[nombre] = valor; return this; },
            attr(nombre, valor) { if (arguments.length === 1) return this.atributos[nombre]; this.atributos[nombre] = valor; return this; },
            text(valor) { this.contenido = valor; return this; },
            html(valor) { this.contenido = valor; return this; },
        });
        return elementos.get(selector);
    };
    $.get = async () => false;
    $.post = async opciones => {
        assert.equal(opciones.url, '/conversaciones/aceptar-accion-externa');
        assert.deepEqual(JSON.parse(opciones.data), { conversacionId: 'c1', accionId: 'a1' });
        return { _id: 'c1', botActivo: true, accionesExternasRequeridas: [
            { _id: 'a1', detalle: 'Evaluar usada.', aceptada: true }, { _id: 'a2', detalle: '<script>detalle</script>', aceptada: false },
        ] };
    };
    const contexto = vm.createContext({ $, io: () => ({ on() {} }), Swal: { fire: () => assert.fail('No debe haber errores') } });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/index.js'), 'utf8'), contexto);
    vm.runInContext("conversaciones = [{ _id: 'c1', botActivo: true, accionesExternasRequeridas: [{ _id: 'a1', detalle: 'Evaluar usada.', aceptada: false }, { _id: 'a2', detalle: '<script>detalle</script>', aceptada: false }] }]; conversacionActual = conversaciones[0]; listarConversaciones = () => {}; actualizarControlBot();", contexto);
    assert.equal($('#contador-intervenciones').contenido, 2);
    assert.match($('#acciones-externas-pendientes').contenido, /&lt;script&gt;/);
    assert.equal($('#acciones-externas-pendientes').contenido.includes('<script>'), false);
    $('#atender').attr('data-aceptar-accion', 'a1');
    await vm.runInContext('aceptarAccionExterna', contexto)({ currentTarget: '#atender' });
    assert.equal($('#contador-intervenciones').contenido, 1);
    assert.equal($('#bot-activo').prop('checked'), true);
    assert.equal($('#acciones-externas-pendientes').contenido.includes('Evaluar usada.'), false);
    assert.match($('#acciones-externas-pendientes').contenido, /data-aceptar-accion="a2"/);
});
