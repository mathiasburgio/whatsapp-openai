const mongoose = require('mongoose');
const oid = mongoose.Schema.Types.ObjectId;
const mixed = mongoose.Schema.Types.Mixed;

const mensajeSchema = new mongoose.Schema({
    conversacionId: oid,
    deClienteParaSistema: Boolean, //ordena en un boolean el sentido de la coversacion
    deSistemaParaCliente: Boolean, //ordena en un boolean el sentido de la coversacion

    emisor: String, //numero de telefono
    receptor: String, //numero de telefono

    contenido: String,

    usoLLM: Boolean,
    accionEjecutada: String, //que accion llamo el LLM
    parametroEjecutado: String, //parametro que uso el LLM (ej "ando buscando una moto honda navi"-> "moto honda navi")
    parametroRecibido: String, //parametro que recibio el LLM (ej {_id: "12345", marca: "honda", modelo: "navi", estado: "nueva"})
    
    esAudio: Boolean,
    transcripcionAudio: String,
    
    esImagen: Boolean,
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
module.exports = mongoose.model('Mensaje', mensajeSchema);
