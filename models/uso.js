const mongoose = require('mongoose');
const oid = mongoose.Schema.Types.ObjectId;

const usoSchema = new mongoose.Schema({
    servicio: String, //nombre del servicio utilizado
    modelo: String, //modelo del servicio utilizado
    estado: String, //pendiente, completado, incompleto, fallido o rechazado sin consumo
    conversacionId: oid,
    tiempoRespuestaMs: Number,
    segundos: Number, //duración en segundos del uso del servicio
    texto: String,
    imagenUrl: String,
    audio: Buffer,
    audioMimeType: String,
    busqueda: String,
    contexto: String,
    preguntasDecision: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    respuestasDecision: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    usoDetalle: mongoose.Schema.Types.Mixed, //usage original, incluidos tokens de caché y razonamiento
    
    esAudio: Boolean, //indica si el uso del servicio fue de tipo audio
    esImagen: Boolean, //indica si el uso del servicio fue de tipo imagen
    esTexto: Boolean, //indica si el uso del servicio fue de tipo texto
    esBusquedaWeb: Boolean,
    esDecision: Boolean,
    esWhatsapp: Boolean, //indica si el uso del servicio fue de tipo WhatsApp
    
    tokensEntrada: Number,
    tokensSalida: Number,
    tokensTotal: Number
    
},{ timestamps: true });

//agrego indice por telefonoCliente y por updatedAt
usoSchema.index({ conversacionId: 1, createdAt: -1 }); 
usoSchema.index({ servicio: 1, createdAt: -1 });
module.exports = mongoose.model('Uso', usoSchema);
