const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module } = require('node:module');

function preparar(t, espera = '30') {
    const anterior = process.env.WAIT_BETWEEN_MESSAGES;
    process.env.WAIT_BETWEEN_MESSAGES = espera;
    t.after(() => {
        if (anterior === undefined) delete process.env.WAIT_BETWEEN_MESSAGES;
        else process.env.WAIT_BETWEEN_MESSAGES = anterior;
    });
    let ahora = 0, siguiente = 0;
    const temporizadores = new Map(), errores = [];
    const reloj = {
        Date: { now: () => ahora },
        setTimeout: (callback, demora) => { const id = ++siguiente; temporizadores.set(id, { callback, fecha: ahora + demora }); return id; },
        clearTimeout: id => temporizadores.delete(id),
        console: { error: (...args) => errores.push(args) },
    };
    const filename = path.resolve(__dirname, '../services/colaMensajes.js');
    const modulo = new Module(filename);
    modulo.require = () => reloj;
    modulo._compile("const { Date, setTimeout, clearTimeout, console } = require('reloj');\n" + fs.readFileSync(filename, 'utf8'), filename);
    async function avanzar(ms) {
        ahora += ms;
        let vencido;
        while ((vencido = [...temporizadores].find(([, item]) => item.fecha <= ahora))) {
            temporizadores.delete(vencido[0]);
            await vencido[1].callback();
        }
    }
    return { api: modulo.exports, avanzar, errores, temporizadores };
}

function mensaje(id, conversacionId = 'c1') {
    return { _id: id, conversacionId, estadoBot: 'pendiente' };
}

test('cada mensaje nuevo reinicia la espera y el bloque se responde una sola vez', async t => {
    const { api, avanzar, temporizadores } = preparar(t);
    const bloques = [];
    const responder = async (ultimo, grupo) => { bloques.push(grupo.map(item => item._id)); ultimo.estadoBot = 'respondido'; };
    api.agregar(mensaje('hola'), responder);
    await avanzar(20000);
    api.agregar(mensaje('precio'), responder);
    await avanzar(20000);
    api.agregar(mensaje('patentada'), responder);
    await avanzar(29999);
    assert.equal(bloques.length, 0);
    await avanzar(1);
    assert.deepEqual(bloques, [['hola', 'precio', 'patentada']]);
    assert.equal(temporizadores.size, 0);
    await avanzar(60000);
    assert.equal(bloques.length, 1);
});

test('las conversaciones esperan por separado y los duplicados no reinician el reloj', async t => {
    const { api, avanzar } = preparar(t);
    const bloques = [];
    const responder = async (ultimo, grupo) => { bloques.push(grupo.map(item => item._id)); ultimo.estadoBot = 'respondido'; };
    api.agregar(mensaje('a'), responder);
    await avanzar(10000);
    api.agregar(mensaje('b', 'c2'), responder);
    api.agregar(mensaje('a'), responder);
    await avanzar(20000);
    assert.deepEqual(bloques, [['a']]);
    await avanzar(10000);
    assert.deepEqual(bloques, [['a'], ['b']]);
});

test('un mensaje durante la generación invalida la respuesta y se une al siguiente bloque', async t => {
    const { api, avanzar } = preparar(t);
    const bloques = [];
    let terminar, controlActual;
    const responder = async (ultimo, grupo, control) => {
        bloques.push(grupo.map(item => item._id));
        if (bloques.length === 1) {
            controlActual = control;
            await new Promise(resolve => { terminar = resolve; });
            assert.equal(control.vigente(), false);
            ultimo.estadoBot = 'pendiente';
        } else ultimo.estadoBot = 'respondido';
    };
    api.agregar(mensaje('a'), responder);
    const generando = avanzar(30000);
    assert.equal(controlActual.vigente(), true);
    api.agregar(mensaje('b'), responder);
    await avanzar(30000);
    assert.equal(bloques.length, 1);
    terminar();
    await generando;
    assert.deepEqual(bloques, [['a'], ['a', 'b']]);
});

test('cancelar elimina la espera e invalida una generación en curso', async t => {
    const { api, avanzar, temporizadores } = preparar(t);
    let llamadas = 0, terminar, controlActual;
    const responder = async (ultimo, grupo, control) => {
        llamadas++;
        controlActual = control;
        await new Promise(resolve => { terminar = resolve; });
        ultimo.estadoBot = 'omitido';
    };
    api.agregar(mensaje('a'), responder);
    assert.equal(api.cancelar('c1').length, 1);
    await avanzar(30000);
    assert.equal(llamadas, 0);
    api.agregar(mensaje('b'), responder);
    const generando = avanzar(30000);
    api.cancelar('c1');
    assert.equal(controlActual.vigente(), false);
    assert.equal(controlActual.cancelada(), true);
    terminar();
    await generando;
    assert.equal(llamadas, 1);
    assert.equal(temporizadores.size, 0);
});

test('cero responde sin espera y un fallo no se recupera ni se reintenta', async t => {
    const { api, avanzar, errores, temporizadores } = preparar(t, '0');
    let llamadas = 0;
    api.agregar(mensaje('a'), async () => { llamadas++; throw new Error('Fallo de procesamiento'); });
    await avanzar(0);
    await avanzar(60000);
    assert.equal(llamadas, 1);
    assert.equal(errores.length, 1);
    assert.equal(temporizadores.size, 0);
});

test('un valor inválido usa treinta segundos y un mensaje omitido no se encola', async t => {
    const { api, avanzar } = preparar(t, '-1');
    let llamadas = 0;
    const responder = async ultimo => { llamadas++; ultimo.estadoBot = 'respondido'; };
    api.agregar({ ...mensaje('omitido'), estadoBot: 'omitido' }, responder);
    api.agregar(mensaje('a'), responder);
    await avanzar(29999);
    assert.equal(llamadas, 0);
    await avanzar(1);
    assert.equal(llamadas, 1);
});
