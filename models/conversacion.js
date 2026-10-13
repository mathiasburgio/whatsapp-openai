const mongoose = require('mongoose');
const oid = mongoose.Schema.Types.ObjectId;
const mixed = mongoose.Schema.Types.Mixed;

const conversacionSchema = new mongoose.Schema({deClienteParaSistema: Boolean, //ordena en un boolean el sentido de la coversacion
    nombre: String, //nombre del cliente
    telefono: String, //telefono del cliente
    resumen: String, //resumen de la conversacion q va generando el bot
    turnosDesdeResumen: { type: Number, default: 0 },
    referralFecha: Date, //último ingreso desde un anuncio de Meta
    consultasFueraDeTema: [new mongoose.Schema({
        fecha: { type: Date, required: true },
        mensajeId: { type: oid, required: true },
    }, { _id: false })],
    accionesExternasRequeridas: [{
        fecha: { type: Date, required: true },
        detalle: { type: String, required: true },
        aceptada: { type: Boolean, default: false },
    }],
    botActivo: { type: Boolean, default: false }, //si debe auto-contestar el LLM
    ultimoMensaje: mixed, //copia del schema de "mensaje"


    intereses: [{
        vehiculoId: oid, //referencia al vehículo de interés
        vehiculo: mixed, //copia local de los datos del vehiculo (que vendran de una API de otro sistema)

        preguntoPrecio: Boolean, //si el cliente preguntó por el precio
        preguntoFinanciamiento: Boolean, //si el cliente preguntó por la financiación
        preguntoEntrega: Boolean, //si el cliente preguntó por la entrega del vehículo
        preguntoGarantia: Boolean, //si el cliente preguntó por la garantía

        lead: String, //frio, tibio, caliente, derivación
    }],
    
    notificacion: [
        // Historial anterior. Las intervenciones nuevas se guardan en accionesExternasRequeridas.
        {
            lead: String, //frio, tibio, caliente, derivación
            resumen: String, //se genera un resumen de la notificación
            creada: Date,
            aceptada: Boolean
        }
    ],

    tokens: { //tokens gastados en la conversacion
        entrada: Number,
        salida: Number,
        total: Number
    }

},{ timestamps: true });

// Permite buscar las conversaciones de un teléfono por actualización.
conversacionSchema.index({ telefono: 1, updatedAt: -1 });
conversacionSchema.index({ 'accionesExternasRequeridas.aceptada': 1, updatedAt: -1, _id: -1 });
module.exports = mongoose.model('Conversacion', conversacionSchema);

/*
Lead:
    explorando - cold - frio
        "Hola, ¿tenés Honda Navi?"
        El bot atiende normalmente. No hace falta molestar al vendedor.

    Interesado — warm - tibio
        "¿Cuánto sale? ¿Tenés financiación?"
        El bot sigue atendiendo y recopila información útil.

    Potencial comprador — hot - caliente
        "Tengo $2 millones para entregar y el resto lo financio."
        Se notifica al vendedor, pero el bot puede continuar atendiendo.

    Derivación — handoff - derivación
        "¿Puedo pasar mañana a comprarla?"
        Se registra una intervención pendiente del vendedor y el bot sigue respondiendo.
*/
