const mongoose = require('mongoose');
const oid = mongoose.Schema.Types.ObjectId;
const mixed = mongoose.Schema.Types.Mixed;

const usoSchema = new mongoose.Schema({deClienteParaSistema: Boolean, //ordena en un boolean el sentido de la coversacion
    servicio: String, //nombre del servicio utilizado
    modelo: String, //modelo del servicio utilizado
    segundos: Number, //duración en segundos del uso del servicio
    
    esAudio: Boolean, //indica si el uso del servicio fue de tipo audio
    esImagen: Boolean, //indica si el uso del servicio fue de tipo imagen
    esTexto: Boolean, //indica si el uso del servicio fue de tipo texto
    esWhatsapp: Boolean, //indica si el uso del servicio fue de tipo WhatsApp
    
    tokensEntrada: Number,
    tokensSalida: Number,
    tokensTotal: Number
    
},{ timestamps: true });

//agrego indice por telefonoCliente y por updatedAt
usoSchema.index({ conversacionId: 1, createdAt: -1 }); 
module.exports = mongoose.model('Uso', usoSchema);
