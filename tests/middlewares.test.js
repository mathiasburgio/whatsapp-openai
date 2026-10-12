const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module } = require('node:module');

test('tieneSesion rechaza sesiones ausentes o deshabilitadas y permite usuarios activos', async () => {
    const filename = path.resolve(__dirname, '../middlewares/tieneSesion.js');
    const modulo = new Module(filename);
    const consultas = [];
    modulo.require = nombre => {
        if (nombre !== '../models/usuarios') throw new Error(`Dependencia inesperada: ${nombre}`);
        return { exists: async filtro => { consultas.push(filtro); return filtro._id === 'activo'; } };
    };
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    const tieneSesion = modulo.exports;
    let estado, respuesta, continuaciones = 0;
    const res = {
        status(valor) { estado = valor; return this; },
        json(valor) { respuesta = valor; return this; },
    };
    const next = error => { if (error) throw error; continuaciones++; };

    await tieneSesion({}, res, next);
    assert.equal(estado, 401);
    assert.match(respuesta.error, /Iniciá sesión/);
    assert.equal(consultas.length, 0);

    await tieneSesion({ session: { usuarioId: 'deshabilitado' } }, res, next);
    assert.equal(estado, 401);
    assert.deepEqual(consultas[0], { _id: 'deshabilitado', habilitado: true });

    await tieneSesion({ session: { usuarioId: 'activo' } }, res, next);
    assert.equal(continuaciones, 1);
});

test('obtenerRawBody conserva los bytes originales para la firma de WhatsApp', () => {
    const obtenerRawBody = require('../middlewares/obtenerRawBody');
    const req = {};
    const body = Buffer.from('{ "mensaje": "hola" }');
    obtenerRawBody(req, {}, body);
    assert.deepEqual(req.rawBody, body);
    assert.notEqual(req.rawBody, body);
});
