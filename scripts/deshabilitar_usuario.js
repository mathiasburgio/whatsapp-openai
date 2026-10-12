const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const mongo = require('../services/mongo');
const usuarios = require('../services/usuarios');

async function main(argumentos = process.argv.slice(2)) {
    if (argumentos.length !== 1)  throw new Error('Uso: npm run deshabilitar_usuario -- <email>');
    const [email] = argumentos;
    usuarios.normalizarEmail(email);

    try {
        await mongo.connectDB();
        const resultado = await usuarios.deshabilitar(email);
        console.log(`Usuario deshabilitado: ${resultado.email}`);
    } finally {
        await mongo.disconnectDB();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { main };
