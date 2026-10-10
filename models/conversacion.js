const mongoose = require('mongoose');
const oid = mongoose.Schema.Types.ObjectId;
const mixed = mongoose.Schema.Types.Mixed;

const conversacionSchema = new mongoose.Schema({deClienteParaSistema: Boolean, //ordena en un boolean el sentido de la coversacion
    deClienteParaSistema: Boolean, //ordena en un boolean el sentido de la coversacion
    deSistemaParaCliente: Boolean, //ordena en un boolean el sentido de la coversacion

    emisor: String,
    receptor: String, //numero de telefono
    intencion: [{
        vehiculoId: oid,
        lead: String, //frio, tibio, caliente, derivación
    }],
    
    ultimoMensaje: Date,
    estadoUltimoMensaje: String, //estado del ultimo mensaje (ej "leido", "entregado", "emitido")
    
    resumen: String,
    
    botActivo: Boolean,
    notificacion: [
        {
            lead: String, //frio, tibio, caliente, derivación
            resumen: String, //se marca por q hay una notificacion
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

//agrego indice por telefonoCliente y por updatedAt
conversacionSchema.index({ conversacionId: 1, createdAt: -1 }); 
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
        Se deriva al vendedor y se suspende la respuesta automática.
*/