const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongo = require('../services/mongo');
const Conversacion = require('../models/conversacion');

async function migrar(coleccion) {
    const camposAnteriores = { $or: [{ requiereAtencion: { $exists: true } }, { motivoDerivacion: { $exists: true } }] };
    let actualizadas = 0;
    for await (const conversacion of coleccion.find(camposAnteriores)) {
        const update = { $unset: { requiereAtencion: '', motivoDerivacion: '' } };
        if (conversacion.requiereAtencion && !(conversacion.accionesExternasRequeridas || []).some(item => String(item._id) === String(conversacion._id))) {
            update.$push = { accionesExternasRequeridas: { _id: conversacion._id,
                fecha: conversacion.updatedAt || new Date(), detalle: conversacion.motivoDerivacion || 'Intervención pendiente anterior.', aceptada: false } };
        }
        const resultado = await coleccion.updateOne({ _id: conversacion._id, ...camposAnteriores }, update);
        actualizadas += resultado.modifiedCount;
    }
    return actualizadas;
}

async function main() {
    try {
        await mongo.connectDB();
        console.log('Conversaciones migradas:', await migrar(Conversacion.collection));
    } finally { await mongo.disconnectDB(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { migrar };
