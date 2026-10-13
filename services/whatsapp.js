const crypto = require('node:crypto');
const orquestador = require('./orquestador');
const Mensaje = require('../models/mensaje');
const Conversacion = require('../models/conversacion');
const accionesExternas = require('./accionesExternas');

const apiVersion = process.env.WHATSAPP_API_VERSION || 'v25.0';
const graphApiBaseUrl = process.env.WHATSAPP_GRAPH_API_URL || 'https://graph.facebook.com';
const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
const defaultPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const webhookVerifyToken = process.env.WEBHOOK_VERIFY_TOKEN;
const appSecret = process.env.WHATSAPP_APP_SECRET;
const internalApiKey = process.env.INTERNAL_API_KEY;

//Recibo las notificaciones del webhook de WhatsApp
async function recibirMensajeWebhook(req, res){

    //VERIFICA LA FIRMA DEL MENSAJE ENTRANTE
    if (!appSecret) return res.sendStatus(503);
    if (!Buffer.isBuffer(req.rawBody)) return res.sendStatus(400);
    const rawBody = req.rawBody;
    const signature = req.get('x-hub-signature-256');
    if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return res.sendStatus(401);
    const expected = Buffer.from(
        `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`,
    );
    const received = Buffer.from(signature);
    const firmaValida = expected.length === received.length && crypto.timingSafeEqual(expected, received);
    if (!firmaValida) return res.sendStatus(401);

    // Confirmamos rápido para que Meta no reintente mientras procesamos la respuesta.
    res.sendStatus(200);

    for (const entry of req.body?.entry || []) {
        for (const change of entry.changes || []) {
            if (change.field !== 'messages') continue;
            const value = change.value || {};
            for (const estado of value.statuses || []) {
                try {
                    await registrarEstado(estado);
                } catch (error) {
                    // La confirmación HTTP ya salió: registramos el fallo para investigar el estado perdido.
                    console.error('No se pudo actualizar el estado del mensaje de WhatsApp:', { id: estado.id, error: error.message });
                }
            }
            for (const recibido of value.messages || []) {
                const telefono = recibido.from;
                const nombre = value.contacts?.find(contacto => contacto.wa_id === telefono)?.profile?.name;
                const mensaje = recibido.text?.body || recibido.image?.caption || recibido.video?.caption
                    || recibido.document?.caption || recibido.button?.text
                    || recibido.interactive?.button_reply?.title || recibido.interactive?.list_reply?.title
                    || `[Mensaje de tipo ${recibido.type || 'desconocido'}]`;
                // console.log('Mensaje entrante de WhatsApp:', { telefono, nombre, tipo: recibido.type, mensaje, id: recibido.id });
                try {
                    await orquestador.recibirMensajeWhatsapp(telefono,
                        recibido.type === 'image' || recibido.type === 'audio' ? (recibido[recibido.type]?.caption || '') : mensaje,
                        recibido.type === 'image' ? recibido.image : undefined,
                        recibido.type === 'audio' ? recibido.audio : undefined,
                        { nombre, receptor: value.metadata?.display_phone_number, phoneNumberId: value.metadata?.phone_number_id,
                            whatsappId: recibido.id, fechaEmitida: recibido.timestamp ? new Date(Number(recibido.timestamp) * 1000) : new Date(),
                            crudo: recibido });
                } catch (error) {
                    // La confirmación HTTP ya salió: los errores se registran sin cerrar el proceso.
                    console.error('No se pudo procesar el mensaje de WhatsApp:', { id: recibido.id, error: error.message });
                }
            }
        }
    }
}

//registra cuando llega un cambio de estado en el mensaje (entregado, leido, fallido) y notifica a los sockets conectados
async function registrarEstado(estado) {
    if (typeof estado?.id !== 'string' || !estado.id || !['delivered', 'read', 'failed'].includes(estado.status)) return false;
    const segundos = Number(estado.timestamp);
    const fecha = new Date(segundos * 1000);
    if (!Number.isFinite(segundos) || segundos <= 0 || Number.isNaN(fecha.getTime())) return false;

    if (estado.status === 'failed') {
        const mensaje = await Mensaje.findOne({ whatsappId: estado.id, deSistemaParaCliente: true });
        if (!mensaje || mensaje.fechaEntregada || mensaje.fechaLeida) return false;
        const motivo = String(estado.errors?.[0]?.message || estado.errors?.[0]?.title || 'WhatsApp informó que no pudo entregar el mensaje.').slice(0, 900);
        console.error('WhatsApp no pudo entregar el mensaje:', { whatsappId: estado.id, motivo });
        const conversacion = await accionesExternas.requerir(mensaje.conversacionId, motivo, mensaje._id);
        await require('./sockets').notificarCambios(conversacion, mensaje);
        return true;
    }

    const filtro = { whatsappId: estado.id, deSistemaParaCliente: true };
    const cambios = {};
    if (estado.status === 'delivered') {
        filtro.fechaEntregada = null;
        cambios.fechaEntregada = fecha;
    } else if (estado.status === 'read') {
        filtro.fechaLeida = null;
        cambios.fechaLeida = fecha;
    }

    const mensaje = await Mensaje.findOneAndUpdate(filtro, { $set: cambios }, { returnDocument: 'after' });
    if (!mensaje) return false;

    const copia = Object.fromEntries(Object.entries(cambios).map(([campo, valor]) => [`ultimoMensaje.${campo}`, valor]));
    const conversacion = await Conversacion.findOneAndUpdate(
        { _id: mensaje.conversacionId, 'ultimoMensaje._id': mensaje._id }, { $set: copia }, { returnDocument: 'after' })
        || await Conversacion.findById(mensaje.conversacionId);
    await require('./sockets').notificarCambios(conversacion, mensaje);
    return true;
}

async function obtenerMediaDesdeWhatsapp(mediaId, { phoneNumberId = defaultPhoneNumberId, maxBytes = 15_000_000 } = {}) {
    if (typeof mediaId !== 'string' || !mediaId.trim()) throw new Error('Falta el ID del archivo de WhatsApp.');
    if (!accessToken) throw new Error('Falta definir WHATSAPP_ACCESS_TOKEN.');
    const headers = { Authorization: `Bearer ${accessToken}` };
    const signal = AbortSignal.timeout(30000);
    const url = new URL(`${graphApiBaseUrl}/${apiVersion}/${encodeURIComponent(mediaId)}`);
    if (phoneNumberId) url.searchParams.set('phone_number_id', phoneNumberId);
    const respuesta = await fetch(url, { headers, signal });
    if (!respuesta.ok) throw new Error(`No se pudo obtener el archivo de WhatsApp: HTTP ${respuesta.status}.`);
    const media = await respuesta.json();
    if (typeof media.url !== 'string' || !media.url.startsWith('https://')) throw new Error('WhatsApp no devolvió una URL HTTPS del archivo.');
    if (Number(media.file_size) > maxBytes) throw new Error('El archivo de WhatsApp supera el tamaño admitido.');
    const archivo = await fetch(media.url, { headers, signal, redirect: 'error' });
    if (!archivo.ok) throw new Error(`No se pudo descargar el archivo de WhatsApp: HTTP ${archivo.status}.`);
    const mimeType = (media.mime_type || archivo.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const partes = [];
    let bytes = 0;
    for await (const parte of archivo.body) {
        bytes += parte.length;
        if (bytes > maxBytes) throw new Error('El archivo de WhatsApp supera el tamaño admitido.');
        partes.push(Buffer.from(parte));
    }
    if (!bytes) throw new Error('El archivo de WhatsApp está vacío.');
    return { buffer: Buffer.concat(partes), mimeType };
}

// Meta llama a este endpoint una vez al configurar el webhook.
async function configurarWebhook(req, res){
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token && token === webhookVerifyToken){
        console.log("Webhook verificado correctamente");
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
}

// Envia un mensaje desde la API de WhatsApp. Devuelve el cuerpo de la respuesta de la API.
async function enviarMensaje({ to, text, phoneNumberId = defaultPhoneNumberId, replyToMessageId=null }) {
    if (!accessToken || !phoneNumberId || typeof to !== 'string' || !/^\d{5,20}$/.test(to)
        || typeof text !== 'string' || !text.trim() || text.length > 4096) {
        throw Object.assign(new Error('Faltan credenciales de WhatsApp o los datos del envío son inválidos.'), { envioNoIniciado: true });
    }
    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: {
            preview_url: false,
            body: text,
        },
    };

    if (replyToMessageId) payload.context = { message_id: replyToMessageId };

    const response = await fetch(
        `${graphApiBaseUrl}/${apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
        },
    );

    const responseText = await response.text();
    let responseBody;
    try {
        responseBody = JSON.parse(responseText);
    } catch {
        responseBody = responseText;
    }

    if (!response.ok) throw Object.assign(new Error(`WhatsApp API ${response.status}: ${JSON.stringify(responseBody)}`), { status: response.status });

    return responseBody;
}

module.exports = {
    recibirMensajeWebhook,
    registrarEstado,
    configurarWebhook,
    enviarMensaje,
    obtenerMediaDesdeWhatsapp,
};
