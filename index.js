require('dotenv').config();

const http = require('http');
const express = require('express');
const app = express();
const server = http.createServer(app);
const whatsappService = require('./services/whatsapp');
const orquestadorService = require('./services/orquestador');
const mongoService = require('./services/mongo');
const fs = require('fs');
const path = require('path');

//creo la carpeta uploads si no existe
if( !fs.existsSync(path.join(__dirname, '/uploads'))) fs.mkdirSync(path.join(__dirname, '/uploads'));
if( !fs.existsSync(path.join(__dirname, '/uploads/audio'))) fs.mkdirSync(path.join(__dirname, '/uploads/audio'));
if( !fs.existsSync(path.join(__dirname, '/uploads/imagenes'))) fs.mkdirSync(path.join(__dirname, '/uploads/imagenes'));

// Midleware necesario para validar mensajes de WhatsApp entrantes
app.use(express.json({
    verify: (req, res, body) => {
        req.rawBody = Buffer.from(body);
    },
}));

// Rutas para el webhook de WhatsApp
app.post('/whatsapp/webhook', whatsappService.recibirMensajeWebhook);
app.get('/whatsapp/webhook', whatsappService.configurarWebhook);

const PORT = process.env.PORT || 3000;

async function iniciar(){
    await mongoService.connectDB();

    server.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

iniciar();
