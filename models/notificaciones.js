const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');

// Las claves se crean una sola vez y persisten entre reinicios.
const clavesSchema = new mongoose.Schema({
    _id: String,
    publicKey: String,
    privateKey: String,
    subject: String,
});

// Al confirmar, la misma invitación conserva la suscripción y deja de admitir usos.
// No lleva TTL: el vencimiento del enlace no debe borrar una suscripción confirmada.
const conexionSchema = new mongoose.Schema({
    _id: { type: String, default: randomUUID },
    venceEn: Date,
    utilizadaEn: Date,
    suscripcion: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

// El UUID del aviso permite consultar únicamente la conversación de esa intervención.
const avisoSchema = new mongoose.Schema({
    _id: { type: String, default: randomUUID },
    conversacionId: mongoose.Schema.Types.ObjectId,
    accionId: mongoose.Schema.Types.ObjectId,
}, { timestamps: true });

module.exports = {
    Claves: mongoose.model('ClavesNotificaciones', clavesSchema),
    Conexion: mongoose.model('ConexionNotificaciones', conexionSchema),
    Aviso: mongoose.model('AvisoNotificacion', avisoSchema),
};
