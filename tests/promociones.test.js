const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const prompts = require('../services/prompts');
const { detectar } = require('../services/promociones');
const Conversacion = require('../models/conversacion');
const reglas = [
    { id: 'general', nombre: 'CORVEN', palabrasClave: ['Más info de CORVEN'] },
    { id: 'modelo', nombre: 'CORVEN XXX', palabrasClave: ['Más info de CORVEN XXX', 'Quiero la CORVEN XXX'] },
];
test('detecta frases sin tildes ni mayúsculas y conserva el texto recibido', () => {
    assert.equal(detectar({ contenidoOriginal: 'Hola! MAS info de corven XXX, por favor' }, reglas), 'Hola! MAS info de corven XXX, por favor');
    assert.equal(detectar({ contenidoOriginal: 'Más info de CORVENas' }, reglas), '');
    assert.equal(detectar({ contenidoOriginal: 'Hola', transcripcionImagen: 'Más info de CORVEN XXX' }, reglas), '');
    assert.equal(detectar({ contenidoOriginal: 'Quiero la CORVEN XXX' }, reglas), 'Quiero la CORVEN XXX');
});
test('conserva el texto del mensaje o el título de una referencia de Meta', () => {
    const referral = { source_type: 'ad', source_id: '123', headline: 'Venta corven' };
    assert.equal(detectar({ contenidoOriginal: 'Hola', crudo: { referral } }, reglas), 'Venta corven');
    assert.equal(detectar({ contenidoOriginal: 'Más info de CORVEN', crudo: { referral } }, reglas), 'Más info de CORVEN');
});
test('marca solo el primer mensaje de la conversación y no cambia el origen después', async () => {
    const conversacion = { _id: 'conv', origenPromocion: '' };
    let primero = { _id: 'primero', contenidoOriginal: 'Hola' }, lecturas = 0, escrituras = 0;
    const filename = path.resolve(__dirname, '../services/promociones.js');
    const mocks = {
        '../models/conversacion': { findOneAndUpdate: async (query, update) => {
            assert.deepEqual(query.origenPromocion, { $in: ['', null] });
            assert.equal(typeof update.$set.origenPromocion, 'string');
            escrituras++;
            Object.assign(conversacion, update.$set); return conversacion;
        } },
        '../models/mensaje': { findOne: query => { assert.equal(query.deClienteParaSistema, true); lecturas++; return { sort: async () => primero }; } },
        './prompts': { leer: async () => ({ contenido: JSON.stringify({ promociones: reglas }) }), validarPromociones: prompts.validarPromociones },
    };
    const modulo = new Module(filename), original = createRequire(filename);
    modulo.require = nombre => mocks[nombre] || original(nombre);
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    await modulo.exports.registrar(conversacion, { _id: 'segundo', contenidoOriginal: 'Más info de CORVEN XXX' });
    assert.equal(conversacion.origenPromocion, '');
    assert.equal(escrituras, 0);
    primero = { _id: 'primero', contenidoOriginal: 'Más info de CORVEN XXX' };
    await modulo.exports.registrar(conversacion, primero);
    assert.equal(conversacion.origenPromocion, 'Más info de CORVEN XXX');
    assert.equal(escrituras, 1);
    assert.equal(lecturas, 2);
    await modulo.exports.registrar(conversacion, { _id: 'otro', contenidoOriginal: 'Quiero la CORVEN XXX' });
    assert.equal(conversacion.origenPromocion, 'Más info de CORVEN XXX');
    assert.equal(escrituras, 1);
    assert.equal(new Conversacion().origenPromocion, '');
});
test('valida reglas configurables y permite desactivar la detección con una lista vacía', () => {
    assert.deepEqual(prompts.validarPromociones('{"promociones":[]}'), []);
    assert.deepEqual(prompts.validarPromociones(JSON.stringify({ promociones: reglas })), reglas);
    assert.throws(() => prompts.validarPromociones('no es JSON'), /JSON/);
    assert.throws(() => prompts.validarPromociones(JSON.stringify({ promociones: [reglas[0], reglas[0]] })), /inválida/);
    assert.throws(() => prompts.validarPromociones(JSON.stringify({ promociones: [{ ...reglas[0], palabrasClave: ['!!!'] }] })), /inválida/);
});
