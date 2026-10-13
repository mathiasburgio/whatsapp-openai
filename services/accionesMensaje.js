const Mensaje = require('../models/mensaje');
const sockets = require('./sockets');

async function registrar(mensaje, accion, estado, detalle = {}) {
    const registro = { accion, estado, fecha: new Date(), detalle };
    // El append atómico conserva también eventos registrados durante una cancelación.
    await Mensaje.updateOne({ _id: mensaje._id }, { $push: { acciones: registro } }, { runValidators: true });
    mensaje.set('acciones', [...(mensaje.acciones || []), registro]);
    // Ya se persistió con $push: los próximos save no deben volver a escribir este array.
    mensaje.unmarkModified('acciones');
    await sockets.notificarCambios(null, mensaje);
}

module.exports = { registrar };
