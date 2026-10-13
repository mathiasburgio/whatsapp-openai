const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const datos = { periodo: { inicio: '2026-10-01T00:00:00.000Z' }, llamadasWebSearch: 2,
    llamadasProcesarTexto: 8, segundosProcesados: 30, tokensProcesados: 12345, imagenesProcesadas: 3,
    respuestasAutomaticas: 0, respuestasWhatsappTotales: 10, respuestasWhatsappConGracia: 3, respuestasWhatsappSinGracia: 7,
    tokensEntrada: 12000, tokensSalida: 345 };

function preparar(respuesta = async () => datos) {
    const elementos = new Map();
    const jquery = selector => {
        if (!elementos.has(selector)) elementos.set(selector, { propiedades: {}, contenido: '',
            on() { return this; },
            prop(nombre, valor) { if (arguments.length === 1) return this.propiedades[nombre]; this.propiedades[nombre] = valor; return this; },
            text(valor) { if (!arguments.length) return this.contenido; this.contenido = valor; return this; },
        });
        return elementos.get(selector);
    };
    jquery.get = url => url === '/sesion/activa' ? Promise.resolve(false) : respuesta();
    const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
    // Bootstrap no está presente: abrir el modal no debe depender de ese recurso externo.
    const contexto = vm.createContext({ $: jquery, io: () => ({ on() {} }), document: { getElementById: () => dialog } });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/index.js'), 'utf8'), contexto);
    return { jquery, dialog, abrir: vm.runInContext('mostrarMetricas', contexto),
        cerrar: vm.runInContext('cerrarMetricas', contexto), limpiar: vm.runInContext('limpiarMetricas', contexto) };
}

test('el botón abre las métricas sin Bootstrap, muestra los datos y permite cerrarlas', async () => {
    const { abrir, cerrar, dialog, jquery } = preparar();
    await abrir();
    assert.equal(dialog.open, true);
    assert.equal(jquery('#metricas-contenido').prop('hidden'), false);
    assert.equal(jquery('#metrica-tokens').text(), '12.345');
    assert.equal(jquery('#metrica-respuestas').text(), '0');
    assert.equal(jquery('#metrica-whatsapp-totales').text(), '10');
    assert.equal(jquery('#metrica-whatsapp-con-gracia').text(), '3');
    assert.equal(jquery('#metrica-whatsapp-sin-gracia').text(), '7');
    assert.match(jquery('#periodo-metricas').text(), /octubre.*2026.*UTC/);
    cerrar();
    assert.equal(dialog.open, false);
});

test('un error de carga queda visible dentro del modal y una respuesta tardía se ignora tras cerrar sesión', async () => {
    const fallido = preparar(async () => { throw { responseJSON: { error: 'No se pudieron obtener las métricas del mes.' } }; });
    await fallido.abrir();
    assert.equal(fallido.dialog.open, true);
    assert.equal(fallido.jquery('#metricas-contenido').prop('hidden'), true);
    assert.equal(fallido.jquery('#metricas-estado').text(), 'No se pudieron obtener las métricas del mes.');

    let resolver;
    const pendiente = preparar(() => new Promise(resolve => { resolver = resolve; }));
    const carga = pendiente.abrir();
    pendiente.limpiar();
    resolver(datos);
    await carga;
    assert.equal(pendiente.dialog.open, false);
    assert.equal(pendiente.jquery('#metricas-contenido').prop('hidden'), true);
    assert.equal(pendiente.jquery('#periodo-metricas').text(), '');
});
