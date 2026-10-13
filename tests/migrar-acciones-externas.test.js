const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');

test('la migración conserva pendientes y estado del bot, elimina los campos antiguos y no duplica al repetir', async () => {
    const fecha = new Date('2026-10-13T12:00:00Z');
    const documentos = [
        { _id: 'c1', requiereAtencion: true, motivoDerivacion: 'Evaluar usada.', botActivo: false, updatedAt: fecha },
        { _id: 'c2', requiereAtencion: false, motivoDerivacion: '', botActivo: true },
        { _id: 'c3', requiereAtencion: true, motivoDerivacion: 'Consulta anterior.', botActivo: true,
            accionesExternasRequeridas: [{ _id: 'existente', fecha, detalle: 'Pendiente nuevo.', aceptada: false }] },
    ];
    const conservaCampos = doc => Object.hasOwn(doc, 'requiereAtencion') || Object.hasOwn(doc, 'motivoDerivacion');
    const coleccion = {
        find: () => documentos.filter(conservaCampos),
        updateOne: async (query, update) => {
            const doc = documentos.find(item => item._id === query._id);
            if (!conservaCampos(doc)) return { modifiedCount: 0 };
            if (update.$push) (doc.accionesExternasRequeridas ||= []).push(update.$push.accionesExternasRequeridas);
            for (const campo of Object.keys(update.$unset)) delete doc[campo];
            return { modifiedCount: 1 };
        },
    };
    const filename = path.resolve(__dirname, '../scripts/migrar_acciones_externas.js');
    const modulo = new Module(filename), original = createRequire(filename);
    const mocks = { dotenv: { config() {} }, '../services/mongo': {}, '../models/conversacion': {} };
    modulo.require = nombre => mocks[nombre] || original(nombre);
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    assert.equal(await modulo.exports.migrar(coleccion), 3);
    assert.equal(documentos[0].accionesExternasRequeridas[0].detalle, 'Evaluar usada.');
    assert.equal(documentos[0].accionesExternasRequeridas[0].fecha, fecha);
    assert.equal(documentos[0].botActivo, false);
    assert.equal(documentos[1].botActivo, true);
    assert.equal(documentos[1].accionesExternasRequeridas, undefined);
    assert.equal(documentos[2].accionesExternasRequeridas.length, 2);
    assert.equal(documentos[2].accionesExternasRequeridas[0].detalle, 'Pendiente nuevo.');
    assert.equal(documentos.some(conservaCampos), false);
    assert.equal(await modulo.exports.migrar(coleccion), 0);
    assert.equal(documentos[2].accionesExternasRequeridas.length, 2);
});
