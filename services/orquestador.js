const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');
const sockets = require('./sockets');

function recibirMensajeWhatsapp(telefono, mensaje, imagen, audio){
    //busco la conversacion, si no existe la creo
    //agrego el mensaje a la conversacion
    //agrego el mensaje a la coleccion de mensajes
    //si hay imagen, llamo a procesar imagen del openai
    //si hay audio, llamo a procesar audio del openai

    //una vez obtenido si es imagen/audio + texto, actualizo la conversacion y la coleccion de mensajes
    //por ahora solo muestro en consola: {mensaje, respuestaOpenAi}
}
async function recibirMensajeVendedor(conversacionId, contenido) {
    const conversacion = await Conversacion.findById(conversacionId);
    if (!conversacion?.telefono) throw new Error('La conversación no tiene teléfono de contacto.');
    const ultimoMensaje = conversacion.ultimoMensaje;
    const emisor = ultimoMensaje?.deClienteParaSistema ? ultimoMensaje.receptor : ultimoMensaje?.emisor;
    const whatsapp = require('./whatsapp');
    const crudo = await whatsapp.enviarMensaje({ to: conversacion.telefono, text: contenido });
    const mensaje = await Mensaje.create({
        conversacionId, contenido, emisor, receptor: conversacion.telefono,
        deClienteParaSistema: false, deSistemaParaCliente: true,
        usoLLM: false, fechaEmitida: new Date(), crudo,
    });
    conversacion.deClienteParaSistema = false;
    conversacion.ultimoMensaje = mensaje.toObject();
    await conversacion.save();
    await sockets.notificarCambios(conversacion, mensaje);
    return mensaje;
}

module.exports = {
    recibirMensajeWhatsapp,
    recibirMensajeVendedor,
    // El webhook todavía utiliza este nombre.
    orquestar: recibirMensajeWhatsapp,
};
