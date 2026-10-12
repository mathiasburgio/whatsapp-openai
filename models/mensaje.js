const mongoose = require('mongoose');
const oid = mongoose.Schema.Types.ObjectId;
const mixed = mongoose.Schema.Types.Mixed;

const mensajeSchema = new mongoose.Schema({
    conversacionId: oid,
    whatsappId: String, //ID entrante de Meta; evita duplicados por reintentos del webhook
    estadoProcesamiento: String, //pendiente, completado o fallido
    errorProcesamiento: String,
    deClienteParaSistema: Boolean, //ordena en un boolean el sentido de la coversacion
    deSistemaParaCliente: Boolean, //ordena en un boolean el sentido de la coversacion

    emisor: String, //numero de telefono
    receptor: String, //numero de telefono

    contenido: String,
    contenidoOriginal: String, //texto del cliente, separado de las transcripciones de IA
    mediaPhoneNumberId: String,

    usoLLM: Boolean,
    respuestaAutomatica: Boolean, //respuesta del bot aceptada por WhatsApp
    respuestaA: oid, //mensaje del cliente que originó la respuesta automática
    estadoBot: String, //pendiente, procesando, enviando, respondido, derivado, omitido, fallido o envio_incierto
    revisionBot: Number,
    errorBot: String,
    solicitudEnvioId: String, //clave de reintento del envío manual desde el panel
    estadoEnvio: String, //enviando, enviado, fallido o envio_incierto
    errorEnvio: String,
    vendedorId: oid,
    accionEjecutada: String, //que accion llamo el LLM
    parametroEjecutado: String, //parametro que uso el LLM (ej "ando buscando una moto honda navi"-> "moto honda navi")
    parametroRecibido: String, //parametro que recibio el LLM (ej {_id: "12345", marca: "honda", modelo: "navi", estado: "nueva"})
    
    esAudio: Boolean,
    audioArchivo: String,
    audioMimeType: String,
    transcripcionAudio: String,
    
    esImagen: Boolean,
    imagenArchivo: String,
    imagenMimeType: String,
    transcripcionImagen: String,

    fechaEmitida: Date, // cuando se deriva el mensaje
    fechaEntrega: Date, // cuando se entrega el mensaje
    fechaLeida: Date, // cuando se lee el mensaje
    
    crudo: mixed, //en crudo lo q llega del webhook

    tokens: { //tokens gastados en el mensaje
        entrada: Number,
        salida: Number,
        total: Number
    }
},{ timestamps: true });

// Permite paginar los mensajes de una conversación por fecha.
mensajeSchema.index({ conversacionId: 1, createdAt: -1 });
mensajeSchema.index({ whatsappId: 1 }, { unique: true, partialFilterExpression: { whatsappId: { $type: 'string' } } });
mensajeSchema.index({ respuestaA: 1 }, { unique: true, partialFilterExpression: { respuestaA: { $type: 'objectId' }, respuestaAutomatica: true } });
mensajeSchema.index({ solicitudEnvioId: 1 }, { unique: true, partialFilterExpression: { solicitudEnvioId: { $type: 'string' } } });
module.exports = mongoose.model('Mensaje', mensajeSchema);
