const mongoose = require('mongoose');
const Conversacion = require('../models/conversacion');
const notificaciones = require('./notificaciones');

/*
QUE HACE ESTE ARCHIVO:
    marca cuando una conversacion requiere intervencion de una persona externa, como un vendedor.
    Tambien marca cuando dicha intervencion ha sido aceptada.
*/

async function requerir(conversacionId, detalle, accionId = new mongoose.Types.ObjectId()) {
    const texto = (String(detalle || '').trim() || 'Se requiere intervención del vendedor.').slice(0, 1000);
    const conversacion = await Conversacion.findOneAndUpdate(
        { _id: conversacionId, 'accionesExternasRequeridas._id': { $ne: accionId } }, 
        {
            $push: { 
                accionesExternasRequeridas: { _id: accionId, fecha: new Date(), detalle: texto, aceptada: false } 
            },
        }, 
        { returnDocument: 'after', runValidators: true });
    if (conversacion) {
        // El envío push no retrasa la respuesta del bot al cliente.
        notificaciones.notificarIntervencion(conversacion, accionId).catch(function registrarErrorNotificacion(error) {
            console.error('No se pudo notificar la intervención:', error.message);
        });
    }
    return conversacion || await Conversacion.findById(conversacionId);
}

async function aceptar(conversacionId, accionId) {
    return Conversacion.findOneAndUpdate(
        { _id: conversacionId, 'accionesExternasRequeridas._id': accionId },
        { 
            $set: { 'accionesExternasRequeridas.$.aceptada': true } 
        }, 
        { returnDocument: 'after', runValidators: true }
    );
}

module.exports = { requerir, aceptar };
