const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module } = require('node:module');

test('el cupo mensual cuenta cualquier respuesta saliente confirmada por WhatsApp', async t => {
    const valorOriginal = process.env.WHATSAPP_MONTHLY_RESPONSE_LIMIT;
    t.after(() => {
        if (valorOriginal === undefined) delete process.env.WHATSAPP_MONTHLY_RESPONSE_LIMIT;
        else process.env.WHATSAPP_MONTHLY_RESPONSE_LIMIT = valorOriginal;
    });
    process.env.WHATSAPP_MONTHLY_RESPONSE_LIMIT = '2';
    let cantidad = 1;
    let filtro;
    const filename = path.resolve(__dirname, '../services/envios.js');
    const modulo = new Module(filename);
    modulo.require = nombre => {
        assert.equal(nombre, '../models/mensaje');
        return { countDocuments: async query => { filtro = query; return cantidad; } };
    };
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    const { verificarLimiteMensual } = modulo.exports;

    await verificarLimiteMensual();
    assert.equal(filtro.deSistemaParaCliente, true);
    assert.deepEqual(filtro.whatsappId, { $type: 'string' });
    assert.equal(Object.hasOwn(filtro, 'respuestaAutomatica'), false);
    assert.equal(filtro.fechaEmitida.$gte.getUTCDate(), 1);
    assert.equal(filtro.fechaEmitida.$lt.getUTCDate(), 1);

    cantidad = 2;
    await assert.rejects(verificarLimiteMensual(), /límite mensual/);
    process.env.WHATSAPP_MONTHLY_RESPONSE_LIMIT = '0';
    cantidad = 0;
    await assert.rejects(verificarLimiteMensual(), /límite mensual/);
});
