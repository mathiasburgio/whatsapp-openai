const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module } = require('node:module');

test('la gracia empieza en el referral y termina exactamente a las 72 horas', () => {
    const { bonificadoReferral } = require('../services/envios');
    const referralFecha = new Date('2026-10-13T12:00:00Z');
    assert.equal(bonificadoReferral({}, referralFecha), false);
    assert.equal(bonificadoReferral({ referralFecha: new Date(NaN) }, referralFecha), false);
    assert.equal(bonificadoReferral({ referralFecha }, new Date('2026-10-13T11:59:59.999Z')), false);
    assert.equal(bonificadoReferral({ referralFecha }, referralFecha), true);
    assert.equal(bonificadoReferral({ referralFecha }, new Date('2026-10-16T11:59:59.999Z')), true);
    assert.equal(bonificadoReferral({ referralFecha }, new Date('2026-10-16T12:00:00Z')), false);
    assert.equal(bonificadoReferral({ referralFecha }, new Date('2026-10-16T12:00:00.001Z')), false);
});

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
