const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const prompts = require('../services/prompts');
const { detectar } = require('../services/promociones');
const reglas = [
    { id: 'general', nombre: 'CORVEN', palabrasClave: ['Más info de CORVEN'], marca: 'Corven', modelo: null },
    { id: 'modelo', nombre: 'CORVEN XXX', palabrasClave: ['Más info de CORVEN XXX', 'Quiero la CORVEN XXX'], marca: 'Corven', modelo: 'XXX' },
];
test('detecta frases sin tildes ni mayúsculas y prioriza el modelo más específico', () => {
    const origen = detectar({ contenidoOriginal: 'Hola! MAS info de corven XXX, por favor' }, reglas);
    assert.equal(origen.promocionId, 'modelo');
    assert.equal(origen.fuente, 'palabra_clave');
    assert.equal(origen.marca, 'Corven');
    assert.equal(origen.modelo, 'XXX');
    assert.equal(detectar({ contenidoOriginal: 'Más info de CORVENas' }, reglas), null);
    assert.equal(detectar({ contenidoOriginal: 'Hola', transcripcionImagen: 'Más info de CORVEN XXX' }, reglas), null);
    assert.equal(detectar({ contenidoOriginal: 'Quiero la CORVEN XXX' }, reglas).promocionId, 'modelo');
});
test('distingue la referencia real de Meta de la coincidencia por palabras', () => {
    const referral = { source_type: 'ad', source_id: '123', source_url: 'https://facebook.com/ad' };
    const origen = detectar({ contenidoOriginal: 'Hola', crudo: { referral } }, reglas);
    assert.equal(origen.fuente, 'meta');
    assert.deepEqual(origen.referenciaMeta, referral);
    assert.equal(origen.promocionId, null);
    assert.equal(detectar({ contenidoOriginal: 'Más info de CORVEN', crudo: { referral } }, reglas).promocionId, 'general');
});
test('marca solo el primer mensaje de la conversación y no cambia el origen después', async () => {
    const conversacion = { _id: 'conv', origenInicializado: false };
    let primero = { contenidoOriginal: 'Hola' }, lecturas = 0;
    const filename = path.resolve(__dirname, '../services/promociones.js');
    const mocks = {
        '../models/conversacion': { findOneAndUpdate: async (query, update) => {
            assert.deepEqual(query.origenInicializado, { $ne: true });
            Object.assign(conversacion, update.$set); return conversacion;
        } },
        '../models/mensaje': { findOne: query => { assert.equal(query.deClienteParaSistema, true); lecturas++; return { sort: async () => primero }; } },
        './prompts': { leer: async () => ({ contenido: JSON.stringify({ promociones: reglas }) }), validarPromociones: prompts.validarPromociones },
    };
    const modulo = new Module(filename), original = createRequire(filename);
    modulo.require = nombre => mocks[nombre] || original(nombre);
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    await modulo.exports.registrar(conversacion, { contenidoOriginal: 'Más info de CORVEN XXX' });
    assert.equal(conversacion.origenInicializado, true);
    assert.equal(conversacion.origenPromocion, undefined);
    primero = { contenidoOriginal: 'Más info de CORVEN XXX' };
    await modulo.exports.registrar(conversacion, primero);
    assert.equal(lecturas, 1);
    conversacion.origenInicializado = false;
    await modulo.exports.registrar(conversacion, primero);
    assert.equal(conversacion.origenPromocion.modelo, 'XXX');
});
test('valida reglas configurables y permite desactivar la detección con una lista vacía', () => {
    assert.deepEqual(prompts.validarPromociones('{"promociones":[]}'), []);
    assert.deepEqual(prompts.validarPromociones(JSON.stringify({ promociones: reglas })), reglas);
    assert.throws(() => prompts.validarPromociones('no es JSON'), /JSON/);
    assert.throws(() => prompts.validarPromociones(JSON.stringify({ promociones: [reglas[0], reglas[0]] })), /inválida/);
    assert.throws(() => prompts.validarPromociones(JSON.stringify({ promociones: [{ ...reglas[0], palabrasClave: ['!!!'] }] })), /inválida/);
});
