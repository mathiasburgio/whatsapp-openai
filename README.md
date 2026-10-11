# WhatsApp + OpenAI

Backend Node.js con MongoDB. El bot y el panel todavía están en desarrollo.

## Configuración

Instalá las dependencias con `npm ci`. Copiá `.env-example` a `.env` si aún no existe y configurá `MONGO_URI`, `SESSION_SECRET` y las credenciales de las APIs necesarias.

Para generar un secreto de sesión:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Guardá el valor como `SESSION_SECRET` en tu `.env`. Conservá ese secreto entre reinicios y mantenelo fuera de Git.

```powershell
npm run iniciar
```

Las sesiones se almacenan en la misma base indicada por `MONGO_URI`, en la colección `<nombre-base>_session`. Por ejemplo, para la base `whatsapp-openai`, la colección y la cookie se llaman `whatsapp-openai_session`. El store reutiliza la conexión de Mongoose. Las cookies son HTTP-only, duran 24 horas y requieren HTTPS cuando `NODE_ENV=production`. No se guardan sesiones sin inicializar.

## Administrar usuarios

```powershell
npm run nuevo_usuario -- "persona@example.com" "Contraseña elegida"
npm run nuevo_usuario -- "persona@example.com"
npm run deshabilitar_usuario -- "persona@example.com"
```

También están disponibles los alias `crear-usuario` y `deshabilitar-usuario`.

El email se normaliza a minúsculas y es único. Las contraseñas se guardan como hashes bcrypt con factor 12; se admiten hasta 72 bytes UTF-8. Si el usuario existe y está deshabilitado, `nuevo_usuario` lo habilita y reemplaza su contraseña cuando se pasa ese parámetro; si se omite, conserva la anterior. La contraseña es obligatoria para crear usuarios nuevos. Si ya está habilitado, conserva su contraseña. Deshabilitar una cuenta no la elimina; un email inexistente produce un error y código de salida 1. Los comandos cierran su conexión al terminar.

Los usuarios se guardan en la colección `usuarios`, con el modelo `Usuario`. Los registros de uso mantienen su modelo y colección independientes. Las rutas de login del panel siguen pendientes.

## Verificación

```powershell
npm test
npm run test:integration
```

Las pruebas unitarias no necesitan MongoDB. La integración requiere MongoDB local en `127.0.0.1:27017`: crea una base temporal `whatsapp_openai_test_<id>`, comprueba los comandos y la persistencia de sesiones y elimina únicamente esa base al finalizar. No utiliza la base configurada en `.env`.

## Trabajo entre máquinas

Publicá tus commits antes de cambiar de máquina y actualizá la rama con `git pull --ff-only` antes de continuar. Ejecutá `npm ci` cuando cambie el lockfile. Cada máquina necesita su propio `.env` y acceso a MongoDB; esos recursos no se comparten por Git.

La integración de sesiones usa las opciones documentadas por [connect-mongo](https://github.com/jdesboeufs/connect-mongo) y [express-session](https://github.com/expressjs/session).

## Recepción de WhatsApp

El webhook público es `https://chat.rpsbikes.com.ar/whatsapp/webhook`. El GET permite verificarlo en Meta con el mismo `WEBHOOK_VERIFY_TOKEN` del servidor. El POST requiere `WHATSAPP_APP_SECRET` y valida la firma `x-hub-signature-256` sobre el cuerpo original; rechaza firmas inválidas con 401 y devuelve 503 si falta el secreto. No requiere una sesión del panel.

Cada mensaje entrante se muestra en consola con teléfono, nombre, tipo, texto o caption e ID. Se recorren todos los mensajes de cada notificación y se omiten los eventos de estado de entrega/lectura. El webhook llama a `recibirMensajeWhatsapp(telefono, mensaje, imagen, audio, datos)`; `imagen` y `audio` son los objetos de archivo que entrega Meta, y `datos` contiene el nombre, número receptor, ID del número, ID del mensaje, fecha y contenido original.

El orquestador crea o reutiliza la conversación por teléfono, guarda el mensaje en `mensajes`, actualiza `ultimoMensaje` y notifica al panel por sockets. Para imágenes o audios obtiene la URL del archivo desde Meta y lo descarga con `WHATSAPP_ACCESS_TOKEN`; luego llama a `procesarImagen` o `transcribirAudio` de OpenAI. Conserva el caption, agrega la descripción o transcripción al contenido, guarda `transcripcionImagen`/`transcripcionAudio` y acumula los tokens en el mensaje y la conversación. El uso de OpenAI queda asociado a esa conversación. Por ahora imprime `{ mensaje, respuestaOpenAi }` en consola; no envía una respuesta automática al cliente. El envío del vendedor permanece deshabilitado.

El campo `whatsappId` tiene un índice único para evitar duplicados por reintentos de Meta. Los mensajes se procesan en orden por teléfono dentro del proceso. Se guarda `estadoProcesamiento` (`pendiente`, `completado` o `fallido`) y `errorProcesamiento` si falla el procesamiento; un mensaje fallido puede reintentarse sin crear otra copia. Los eventos antiguos no reemplazan un último mensaje más reciente. Las imágenes tienen un límite de 5 MB y los audios de 15 MB, por el almacenamiento de uso de OpenAI en MongoDB. Las notas de voz OGG son compatibles; AAC y AMR requieren conversión previa a un formato que admita el servicio de transcripción.

La confirmación HTTP 200 se envía antes de procesar los mensajes para responder rápido a Meta. El procesamiento continúa en el mismo servidor: no hay una cola persistente, por lo que un cierre del proceso después de confirmar y antes de guardar puede perder ese evento. Los fallos posteriores se guardan cuando es posible y se muestran en consola; no provocan una respuesta automática ni un reintento de Meta por el estado HTTP.

## Decisions de OpenAI

`services/openai.js` exporta `procesarDecision(prompt, opciones, configuracion)`. Evalúa el prompt y elige una de las opciones usando `POST /v1/decisions`, con una pregunta de tipo `choice`. La configuración y la respuesta siguen la [referencia oficial de Decisions](https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create).

```javascript
const mongo = require('./services/mongo');
const { procesarDecision } = require('./services/openai');

// Cargá .env antes de llamar y mantené MongoDB conectado durante la consulta.
require('dotenv').config();
async function clasificar() {
    try {
        await mongo.connectDB();
        const decision = await procesarDecision(
            'Quiero comprar una moto en cuotas.',
            [
                { value: 'comprar', description: 'Precios, compra o financiación.' },
                { value: 'servicio', description: 'Mantenimiento, reparación o repuestos.' },
                { value: 'otro', description: 'Ninguna de las anteriores.' },
            ],
            { instrucciones: 'Clasificá la intención principal del cliente.', nombre: 'intencion_cliente' },
        );
        if (decision.resultado.type === 'refusal') {
            console.log('El modelo no respondió esta pregunta.');
        } else {
            console.log(decision.resultado.choice, decision.resultado.confidence);
        }
        console.log(decision.tokensGastados, decision.uso);
        return decision;
    } finally {
        await mongo.disconnectDB();
    }
}
clasificar().catch(error => { console.error(error.message); process.exitCode = 1; });
```

Las opciones pueden ser strings, booleanos o objetos `{ value, description }`; deben ser únicas y se admiten entre 2 y 255. `value` admite strings y booleanos. La configuración acepta:

| Campo | Uso |
| --- | --- |
| `instrucciones` | Criterio para elegir; por defecto pide la opción que mejor corresponda al texto. |
| `nombre` | Nombre de la pregunta; por defecto `decision`. |
| `modelo` | Reemplaza `OPENAI_DECISIONS_MODEL`; por defecto `gpt-6-luna`. |
| `safetyIdentifier` | Identificador opaco del usuario, de hasta 128 caracteres. |
| `conversacionId` | Asocia el consumo a una conversación de MongoDB. |
| `signal` | Permite cancelar con un `AbortSignal`. |

Decisions tiene configuración propia: no admite `json`, `maxTokensSalida` ni `razonamiento`. Esta función cubre la elección entre opciones para texto. La API también ofrece preguntas `predicate`, `score` y entrada de imágenes, descritas en la [guía oficial](https://developers.openai.com/api/docs/guides/decisions).

La respuesta incluye `resultado` (objeto tipado con elección, confianza y probabilidades, o `type: 'refusal'`), `tokensGastados` (`entrada`, `salida`, `total`), `uso` (el `usage` original), `modelo` y `tiempoRespuestaMs`. Una negativa tipada se devuelve para que quien llama pueda manejarla; los errores HTTP, de red o de respuesta inválida lanzan una excepción.

Cada llamada se registra en `usos` con `esDecision: true` y `esTexto: true`: prompt en `texto`, instrucciones en `contexto`, opciones en `preguntasDecision`, respuestas en `respuestasDecision`, detalle de uso en `usoDetalle`, tokens, modelo, estado y duración. Comparte `LLM_MONTHLY_TEXT_QUERY_LIMIT` con las consultas de texto e imagen y reserva una consulta antes de enviar. Las negativas y errores de red conservan el cupo; los rechazos HTTP sin consumo siguen las reglas existentes. No se estiman precios monetarios: se guarda el consumo informado por OpenAI.

### Script de prueba

Requiere `OPENAI_API_KEY`, `MONGO_URI` y MongoDB disponible. Podés configurar `OPENAI_DECISIONS_MODEL` en `.env`; según la [guía oficial](https://developers.openai.com/api/docs/guides/decisions), el modelo disponible actualmente es `gpt-6-luna`.

```powershell
# Prompt y opciones del ejemplo incluido.
npm run probar_decisions

# Prompt propio y opciones del ejemplo.
npm run probar_openai -- decisions "Necesito reparar mi moto."

# Prompt propio y archivo JSON con opciones, instrucciones y demás configuración.
npm run probar_decisions -- "Quiero comprar una moto" scripts/decisions-example.json

npm run probar_decisions -- --help
```

Copiá `scripts/decisions-example.json` y editá `opciones`, `instrucciones`, `nombre` y, opcionalmente, `modelo`, `conversacionId` o `safetyIdentifier`. Las rutas de archivos personalizados se resuelven desde la carpeta donde ejecutás el comando. El script imprime la decisión y el consumo, registra el uso real y cierra MongoDB al terminar, incluso si la llamada falla. Estas pruebas consumen la API; `npm test` usa respuestas simuladas y no consume OpenAI.
