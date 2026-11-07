/*
 * Registra el historial de procesamiento de cada mensaje: qué acción realizó
 * el sistema, cuándo y con qué resultado (iniciada, ok, error u omitida).
 * Las acciones las ejecutan el bot y el orquestador; este módulo guarda sus
 * eventos en mensaje.acciones, actualiza el objeto en memoria y notifica
 * al panel por sockets para mostrar los cambios.
 *
 * Ejemplo de uso desde el bot:
 * await accionesMensaje.registrar(mensaje, 'buscar_vehiculo', 'iniciada', {
 *     filtro: { marca: 'Honda' },
 * });
 * // El bot consulta el catálogo y después registra el resultado:
 * await accionesMensaje.registrar(mensaje, 'buscar_vehiculo', 'ok', {
 *     cantidad: 12,
 * });
 */
const Mensaje = require('../models/mensaje');
const sockets = require('./sockets');

async function registrar(mensaje, accion, estado, detalle = {}) {
    const registro = { accion, estado, fecha: new Date(), detalle };
    // El append atómico conserva también eventos registrados durante una cancelación.
    await Mensaje.updateOne(
        { _id: mensaje._id }, 
        { $push: { acciones: registro } }, 
        { runValidators: true }
    );
    mensaje.set('acciones', [...(mensaje.acciones || []), registro]);
    // Ya se persistió con $push: los próximos save no deben volver a escribir este array.
    mensaje.unmarkModified('acciones');
    await sockets.notificarCambios(null, mensaje);
}

module.exports = { registrar };
