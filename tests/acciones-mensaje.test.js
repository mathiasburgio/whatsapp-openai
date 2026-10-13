const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module } = require('node:module');
const Mensaje = require('../models/mensaje');

function cargar(modelo, sockets) {
    const filename = path.resolve(__dirname, '../services/accionesMensaje.js');
    const modulo = new Module(filename);
    modulo.require = nombre => nombre === '../models/mensaje' ? modelo : sockets;
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    return modulo.exports;
}

test('las acciones se anexan en Mongo antes de notificarlas y otro save no sobrescribe el historial', async () => {
    const mensaje = Mensaje.hydrate({ _id: '507f1f77bcf86cd799439011', contenido: 'Hola', acciones: [] });
    const persistidas = [], avisos = [];
    const api = cargar({ updateOne: async (query, update) => {
        assert.equal(String(query._id), String(mensaje._id));
        persistidas.push(update.$push.acciones);
    } }, { notificarCambios: async (conversacion, actual) => {
        assert.equal(conversacion, null);
        assert(actual.acciones.every(registro => persistidas.some(item => item.accion === registro.accion && item.estado === registro.estado)));
        avisos.push(actual.toObject());
    } });
    await Promise.all([
        api.registrar(mensaje, 'interpretar', 'iniciada'),
        api.registrar(mensaje, 'esperar_mensajes', 'omitida', { motivo: 'El vendedor respondió.' }),
    ]);
    assert.equal(persistidas.length, 2);
    assert.equal(mensaje.acciones.length, 2);
    assert.equal(avisos.at(-1).acciones.length, 2);
    mensaje.estadoBot = 'omitido';
    const cambiosDelSave = mensaje.$getChanges();
    assert.equal(Object.hasOwn(cambiosDelSave.$set || {}, 'acciones'), false);
    assert.equal(Object.hasOwn(cambiosDelSave.$push || {}, 'acciones'), false);
    assert.equal(cambiosDelSave.$set.estadoBot, 'omitido');
});

test('un fallo al guardar una acción no publica un evento que nunca fue persistido', async () => {
    const mensaje = Mensaje.hydrate({ _id: '507f1f77bcf86cd799439011', acciones: [] });
    let avisos = 0;
    const api = cargar({ updateOne: async () => { throw new Error('Mongo no disponible'); } },
        { notificarCambios: async () => { avisos++; } });
    await assert.rejects(api.registrar(mensaje, 'interpretar', 'iniciada'), /Mongo no disponible/);
    assert.equal(avisos, 0);
    assert.equal(mensaje.acciones.length, 0);
});
