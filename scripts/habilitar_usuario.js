const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const mongo = require('../services/mongo');
const usuarios = require('../services/usuarios');
const Usuario = require('../models/usuarios');

async function main(argumentos = process.argv.slice(2)) {
    if (argumentos.length < 1 || argumentos.length > 2)  throw new Error('Uso: npm run habilitar_usuario -- <email> [contraseña] (obligatoria para usuarios nuevos)');
    const [email, contrasena] = argumentos;
    usuarios.normalizarEmail(email);
    if (contrasena !== undefined) usuarios.validarContrasena(contrasena);

    try {
        await mongo.connectDB();
        // Esperamos el índice único antes de permitir la creación de cuentas.
        await Usuario.init();
        const resultado = await usuarios.nuevo(email, contrasena);
        const mensajes = {
            creado: 'Usuario creado',
            habilitado: contrasena !== undefined
                ? 'Usuario habilitado con la contraseña indicada'
                : 'Usuario habilitado; se conserva su contraseña',
            existente: 'El usuario ya está habilitado; se conserva su contraseña',
        };
        console.log(`${mensajes[resultado.accion]}: ${resultado.email}`);
    } finally {
        await mongo.disconnectDB();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.code === 11000 ? 'El email ya existe. Volvé a ejecutar el comando.' : error.message);
        process.exitCode = 1;
    });
}

module.exports = { main };
