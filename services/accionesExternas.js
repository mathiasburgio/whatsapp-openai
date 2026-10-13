const mongoose = require('mongoose');
const Conversacion = require('../models/conversacion');

async function requerir(conversacionId, detalle, accionId = new mongoose.Types.ObjectId()) {
    const texto = (String(detalle || '').trim() || 'Se requiere intervención del vendedor.').slice(0, 1000);
    const conversacion = await Conversacion.findOneAndUpdate({ _id: conversacionId,
        'accionesExternasRequeridas._id': { $ne: accionId } }, {
        $push: { accionesExternasRequeridas: { _id: accionId, fecha: new Date(), detalle: texto, aceptada: false } },
    }, { returnDocument: 'after', runValidators: true });
    return conversacion || await Conversacion.findById(conversacionId);
}

async function aceptar(conversacionId, accionId) {
    return Conversacion.findOneAndUpdate({ _id: conversacionId, 'accionesExternasRequeridas._id': accionId },
        { $set: { 'accionesExternasRequeridas.$.aceptada': true } }, { returnDocument: 'after', runValidators: true });
}

module.exports = { requerir, aceptar };
