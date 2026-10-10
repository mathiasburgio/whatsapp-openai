const crypto = require('node:crypto');
const orquestador = require('./orquestador');

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
    if(!appSecret) throw "App secret is not defined";
    const rawBody = Buffer.from(req.rawBody);
    const signature = req.get('x-hub-signature-256');
    if (!signature || !signature.startsWith('sha256=') || !rawBody) return false;
    const expected = Buffer.from(
        `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`,
    );
    const received = Buffer.from(signature);
    const firmaValida = expected.length === received.length && crypto.timingSafeEqual(expected, received);
    if(!firmaValida) throw "Invalid signature";

    // Confirmamos rápido para que Meta no reintente mientras procesamos la respuesta.
    res.sendStatus(200);

    // Aquí puedes procesar el mensaje entrante según tus necesidades.
    orquestador.orquestar({});
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

async function enviarMensaje({ to, text, phoneNumberId = defaultPhoneNumberId, replyToMessageId=null }) {

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
        `${graphApiBaseUrl}/${apiVersion}/${phoneNumberId}/messages`,
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

    if (!response.ok) throw new Error(`WhatsApp API ${response.status}: ${JSON.stringify(responseBody)}`);

    return responseBody;
}

module.exports = {
    recibirMensajeWebhook,
    configurarWebhook,
    enviarMensaje,
};