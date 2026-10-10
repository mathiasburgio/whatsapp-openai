const mongoose = require('mongoose');
const oid = mongoose.Schema.Types.ObjectId;
const mixed = mongoose.Schema.Types.Mixed;

const usoSchema = new mongoose.Schema({deClienteParaSistema: Boolean, //ordena en un boolean el sentido de la coversacion
    email: String,
    contrasena: String,
    habilitado: Boolean,
},{ timestamps: true });

//agrego indice por telefonoCliente y por updatedAt
usoSchema.index({ conversacionId: 1, createdAt: -1 }); 
module.exports = mongoose.model('Uso', usoSchema);
