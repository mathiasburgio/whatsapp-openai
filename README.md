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

El panel usa `POST /sesion/iniciar`, `POST /sesion/cerrar` y `GET /sesion/activa`. Este último responde el booleano `true` o `false`.

## Administrar usuarios

```powershell
npm run habilitar_usuario -- "persona@example.com" "Contraseña elegida"
npm run habilitar_usuario -- "persona@example.com"
npm run deshabilitar_usuario -- "persona@example.com"
```

El email se normaliza a minúsculas y es único. Las contraseñas se guardan como hashes bcrypt con factor 12; se admiten hasta 72 bytes UTF-8. Si el usuario existe y está deshabilitado, `habilitar_usuario` lo habilita y reemplaza su contraseña cuando se pasa ese parámetro; si se omite, conserva la anterior. La contraseña es obligatoria para crear usuarios nuevos. Si ya está habilitado, conserva su contraseña. Deshabilitar una cuenta no la elimina; un email inexistente produce un error y código de salida 1. Los comandos cierran su conexión al terminar.

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

El log del contenido entrante en el webhook está comentado. Se recorren todos los mensajes de cada notificación y se omiten los eventos de estado de entrega/lectura. El webhook llama a `recibirMensajeWhatsapp(telefono, mensaje, imagen, audio, datos)`; `imagen` y `audio` son los objetos de archivo que entrega Meta, y `datos` contiene el nombre, número receptor, ID del número, ID del mensaje, fecha y contenido original.

El orquestador crea o reutiliza la conversación por teléfono, guarda el mensaje en `mensajes`, actualiza `ultimoMensaje` y notifica al panel por sockets. Para imágenes o audios obtiene la URL del archivo desde Meta y lo descarga con `WHATSAPP_ACCESS_TOKEN`; luego llama a `procesarImagen` o `transcribirAudio` de OpenAI usando sus prompts editables. Conserva el caption, agrega la descripción o transcripción al contenido, guarda `transcripcionImagen`/`transcripcionAudio` y acumula los tokens en el mensaje y la conversación. El uso de OpenAI queda asociado a esa conversación y al mensaje que originó la llamada mediante `mensajeId`; el audio no se duplica en `usos`. Imprime `{ mensaje, respuestaOpenAi }` en consola. Si el bot estaba activo al recibir el mensaje y sigue activo antes del envío, genera la respuesta automática. El vendedor también puede responder desde el panel.

El campo `whatsappId` tiene un índice único para evitar duplicados por reintentos de Meta. Los mensajes se procesan en orden por teléfono dentro del proceso. Si falla el procesamiento de un archivo, se registra el error en consola y se conserva el mensaje, sin guardar un estado de procesamiento. Los eventos antiguos no reemplazan un último mensaje más reciente. Al aceptar un envío se completa `fechaEmitida`; los avisos `delivered` y `read` de WhatsApp completan `fechaEntregada` y `fechaLeida`, actualizan la copia en `ultimoMensaje` y notifican por sockets. Un aviso `failed` se informa en consola y marca la conversación para atención. La descarga admite imágenes de hasta 5 MB y audios de hasta 15 MB. Las notas de voz OGG son compatibles; AAC y AMR requieren conversión previa a un formato que admita el servicio de transcripción.

La confirmación HTTP 200 se envía antes de procesar los mensajes para responder rápido a Meta. El procesamiento continúa en el mismo servidor: no hay una cola persistente, por lo que un cierre del proceso después de confirmar y antes de guardar puede perder ese evento. Los fallos posteriores se guardan cuando es posible y se muestran en consola; no provocan una respuesta automática ni un reintento de Meta por el estado HTTP.

El panel muestra las imágenes y permite reproducir los audios con los controles del navegador. El caption del cliente se muestra separado de la descripción de la imagen, que aparece en un recuadro violeta con la etiqueta **Inferencia de IA**. Las actualizaciones por socket conservan el reproductor para no interrumpir la reproducción.

El orquestador descarga los archivos al recibirlos y los guarda antes de consultar a OpenAI en `uploads/imagenes` y `uploads/audio`. `imagenArchivo` y `audioArchivo` contienen solo el nombre generado del archivo. El panel los solicita en `GET /uploads/imagenes/<nombre>` o `GET /uploads/audio/<nombre>`; estas rutas requieren una sesión de usuario habilitado, que en este sistema corresponde a un administrador del panel. No se exponen el token ni la URL temporal de Meta. Si falla la descarga, el error se muestra en consola y el mensaje queda guardado sin archivo. **Conservá la carpeta `uploads` entre despliegues y copiala al migrar de servidor junto con MongoDB**; está excluida de Git. En varias instancias, esta carpeta debe estar en un volumen compartido. La reproducción depende de los formatos que admita el navegador.

## Controles y métricas del panel

La barra superior permite cerrar sesión, abrir las métricas del mes actual y editar **Prompts**. El listado usa `GET /conversaciones/obtener` y los mensajes de una conversación se consultan con `GET /conversacion/mensajes?conversacionId=...&pagina=...`. El interruptor usa `POST /conversaciones/habilitar-bot` o `POST /conversaciones/deshabilitar-bot`, con `conversacionId` en el cuerpo JSON, y actualiza los paneles abiertos por socket. Las conversaciones nuevas empiezan con el bot inactivo. Al activarlo, responde a los próximos mensajes del cliente; no responde mensajes anteriores omitidos. Las solicitudes al vendedor se acumulan en `accionesExternasRequeridas`, con `fecha`, `detalle` y `aceptada: false`, y el bot sigue respondiendo las demás consultas. Cada pedido aparece en el encabezado y se cierra por separado con **Marcar atendida**, sin cambiar el estado del bot. Esa marca indica que la gestión fue atendida; no confirma una aprobación comercial. El bot vuelve a comprobar `botActivo` antes de enviar una respuesta en curso.

El listado tiene botones **Últimas** y **Sin responder**. Las conversaciones con intervenciones sin atender aparecen siempre primero y parpadean; después se ordena por fecha de actualización. Se respeta la preferencia de movimiento reducido del navegador. **Sin responder** muestra chats cuyo último mensaje es del cliente y chats con intervenciones pendientes, aunque el bot haya contestado otras preguntas. El filtro y la prioridad se aplican en el servidor antes del límite de 300 chats, y se actualizan por socket.

Para responder manualmente, seleccioná un chat, escribí y pulsá **Enviar** (Enter envía; Shift+Enter inserta una línea). `enviar-mensaje` valida la sesión vigente, usuario habilitado, conversación y texto de hasta 4096 caracteres. Envía por WhatsApp usando el número asociado al chat, guarda el mensaje cuando Meta confirma su ID y lo muestra a todos los paneles conectados. La respuesta manual conserva el estado del bot y los pedidos pendientes: usá el interruptor si querés pausarlo y **Marcar atendida** para cerrar cada gestión resuelta. No consume OpenAI ni aumenta las métricas de respuestas automáticas.

Para conversaciones ya guardadas, ejecutá `npm run migrar_acciones_externas` en el servidor con su `MONGO_URI`. Convierte los pendientes anteriores al nuevo acumulador y elimina `requiereAtencion` y `motivoDerivacion`, conservando el estado del bot y las acciones ya registradas. Puede ejecutarse nuevamente sin duplicar datos. Cambiar el modelo por sí solo no elimina esos campos de MongoDB.

El panel deshabilita el cuadro de texto y el botón mientras espera la confirmación, para evitar dos envíos por doble clic. Si no llega una confirmación, conserva el texto y muestra el error; revisá la conversación antes de volver a enviarlo, porque Meta podría haberlo aceptado. Los mensajes confirmados conservan `vendedorId` y `fechaEmitida`. La entrega y la lectura se muestran con `fechaEntregada` y `fechaLeida`.

`GET /metricas/mes` requiere una sesión habilitada, al igual que el cambio de estado. Permite consultar otro período con `?anio=2026&mes=10`; cada parámetro omitido toma el valor actual del reloj UTC del servidor. Usa meses UTC, coincidentes con los límites de OpenAI. Cuenta las llamadas registradas de búsquedas web y de `procesarTexto` (sin incluir búsquedas ni Decisions en esta última cifra), excluyendo usos rechazados sin consumo. Los segundos de audio y las imágenes cuentan usos completados; los tokens suman el consumo informado, incluidos los errores que consumieron tokens. Las respuestas automáticas cuentan únicamente mensajes salientes con `respuestaAutomatica: true` y un ID aceptado por WhatsApp; no se cuentan mensajes manuales ni entrantes.

## Prompts, respuestas y catálogo

Los prompts activos están en `prompts/`: `BASE.md` contiene reglas comunes; `COMERCIO.md`, información comercial confirmada; `ORQUESTADOR.md`, selección de acciones; `RESPUESTA.md`, redacción; `RESUMEN.md`, memoria; `IMAGEN.md` y `AUDIO.md`, interpretación de archivos. `PROMPT_MAESTRO_EXAMPLE.md` se conserva como referencia y no se envía al modelo. **Completá los datos pendientes de COMERCIO antes de activar el bot**: dirección, horarios, pagos y financiación no se inventan.

El editor requiere sesión habilitada (`GET /prompts/obtener`, `POST /prompts/guardar`). El guardado recibe `id`, `contenido` y `version` en el cuerpo JSON. Solo permite los archivos conocidos, valida tamaños, escribe de forma atómica y rechaza con 409 guardar sobre una versión que cambió en otro editor. Las modificaciones se leen en la siguiente recepción; cada respuesta usa una misma copia de las reglas. Conservá estos archivos y sus permisos de escritura al migrar o desplegar: un despliegue que copie los valores de Git puede reemplazar ajustes realizados desde el panel. Varias instancias deben compartirlos.

Con el bot activo, `services/bot.js` envía a Responses las reglas comunes, el comercio y el prompt de cada etapa, con resumen y hasta 12 mensajes recientes (acotados en tamaño). Usa [salidas estructuradas](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) para elegir `responder`, `buscar_vehiculo` o `notify_seller`; el servidor valida la acción y los filtros, consulta el catálogo si corresponde y redacta el mensaje. No usa búsquedas web para confirmar precios o stock. Cada turno normal usa dos llamadas de texto; cada `BOT_RESUMEN_CADA_TURNOS` respuestas agrega una llamada para actualizar `resumen` (por defecto 5). Imágenes y audio agregan su procesamiento propio. Todas estas llamadas cuentan consumo y respetan los límites de OpenAI.

`WAIT_BETWEEN_MESSAGES` indica los segundos de silencio antes de responder (30 por defecto; 0 elimina la espera). Cada mensaje nuevo del mismo chat reinicia el temporizador. Los originales se guardan y aparecen individualmente en el panel; el bot recibe el bloque completo en `mensajeActual` y envía una sola respuesta, asociada al último mensaje. Los anteriores quedan con `estadoBot=agrupado`. Si llega otro mensaje durante la generación y todavía no comenzó el envío a WhatsApp, se descarta esa respuesta y se prepara otra con el bloque ampliado; el consumo realizado sigue registrado. Desactivar el bot cancela la espera; una respuesta manual por sí sola no la cancela. La cola de agrupación está únicamente en memoria: se descarta al reiniciar y no recupera ni reintenta procesamiento interrumpido.

Los mensajes entrantes nuevos guardan un historial `acciones`: cada evento contiene `accion`, `estado` (`iniciada`, `ok`, `error` u `omitida`), `fecha` y `detalle`. Se registra recepción, procesamiento de archivos, espera, interpretación, búsqueda, generación, envío, solicitud de intervención y resumen cuando corresponda. El inicio y el resultado se agregan como eventos separados y se guardan al ocurrir. La interpretación conserva la acción elegida y si el catálogo estaba habilitado; una búsqueda omitida o fallida conserva su motivo. `responder=ok` indica que WhatsApp confirmó un ID, mientras la entrega y lectura siguen usando sus fechas específicas. En un bloque agrupado, el último mensaje contiene el recorrido y los anteriores lo referencian mediante `agrupar_mensajes.detalle.mensajePrincipalId`. El modal JSON abierto se actualiza por socket. Los campos `accionEjecutada`, `parametroEjecutado` y `parametroRecibido` se conservan. El registro no habilita recuperación ni reintentos después de reiniciar.

El catálogo se configura con `VEHICULOS_API_URL=https://rpsbikes.com.ar/buscar` y requiere `VEHICULOS_API_HABILITADA=true` para consultarlo. Busca únicamente por `marca`, `modelo`, `precioMinimo` y `precioMaximo`; admite un array de vehículos o `{ "vehiculos": [...] }`. Los límites de precio son números no negativos y solo se incluyen cuando el cliente indica un presupuesto; preguntar el precio de una moto no agrega límites. El primer paso del LLM identifica esos filtros. Después de consultar la API, otra llamada recibe el mensaje y los resultados para comparar estado, color, tipo y demás preferencias, informar `disponible` y el precio cuando estén presentes, e incluir el `enlace` informado por el catálogo. No se asume que una moto sea nueva: una consulta general por Honda Navi puede responderse con una opción usada si los datos la confirman. Si el cliente pide nueva y se encuentra usada, se aclara la diferencia antes de ofrecerla como alternativa. La condición de conservación solo se describe cuando el catálogo la informa. Estado, color, tipo y vehículo no se envían como filtros; también se eliminan de la URL configurada si quedaron parámetros anteriores. El token opcional `VEHICULOS_API_TOKEN` se envía solo desde el servidor. Si el catálogo está deshabilitado o falla, registra una intervención pendiente para el vendedor y el bot puede continuar con otras consultas. Los errores técnicos de generación, envío o entrega también registran una intervención y conservan el estado del bot. El mensaje fallido no se reintenta automáticamente; los siguientes mensajes se procesan normalmente si el bot sigue activo. El único bloqueo automático del bot es por uso indebido, según la regla de consultas fuera de tema; el interruptor manual sigue disponible.

El límite `WHATSAPP_MONTHLY_RESPONSE_LIMIT` se revisa antes de cada envío manual o automático (0 bloquea envíos). Cuentan las respuestas salientes con un ID confirmado por WhatsApp; cada respuesta manual aceptada consume un cupo igual que una automática. El reclamo atómico de cada mensaje y el índice `respuestaA` evitan respuestas automáticas duplicadas por reintentos. Un envío manual sin confirmación no se guarda como enviado ni se reintenta automáticamente; revisá la conversación porque Meta podría haberlo aceptado. Un cierre del proceso mientras `estadoBot` es `procesando` o `enviando` tampoco se reintenta automáticamente; revisá los mensajes y la confirmación de Meta. Las colas de orden y límites son locales al proceso, como el control de consumo existente; varias instancias requieren una cola y cuotas compartidas.

El orquestador devuelve `mensajesFueraDeTema` con IDs de mensajes del bloque actual cuya consulta principal sea claramente ajena a las motos o al comercio. Saludos, agradecimientos, consultas ambiguas, reclamos y consultas comerciales sin datos suficientes no se consideran fuera de tema. Se guarda cada ID una sola vez en `conversacion.consultasFueraDeTema`, con `fecha` y `mensajeId`; en un bloque se cuentan los mensajes originales por separado. El historial se conserva y solo cuentan registros de las últimas 24 horas (menos de 24 horas de antigüedad). La primera y segunda consulta reciben una orientación hacia el comercio. La tercera pausa el bot inmediatamente, cancela la cola de espera y agrega una intervención pendiente en `accionesExternasRequeridas`, antes de generar o enviar otra respuesta automática. La detección y el bloqueo quedan en `acciones`. La reactivación es manual desde el panel y no borra el historial.

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
| `mensajeId` | Asocia el consumo al mensaje que originó la llamada, cuando existe. |
| `signal` | Permite cancelar con un `AbortSignal`. |

Decisions tiene configuración propia: no admite `json`, `maxTokensSalida` ni `razonamiento`. Esta función cubre la elección entre opciones para texto. La API también ofrece preguntas `predicate`, `score` y entrada de imágenes, descritas en la [guía oficial](https://developers.openai.com/api/docs/guides/decisions).

La respuesta incluye `resultado` (objeto tipado con elección, confianza y probabilidades, o `type: 'refusal'`), `tokensGastados` (`entrada`, `salida`, `total`), `uso` (el `usage` original), `modelo` y `tiempoRespuestaMs`. Una negativa tipada se devuelve para que quien llama pueda manejarla; los errores HTTP, de red o de respuesta inválida lanzan una excepción.

Cada llamada se registra en `usos` con `esDecision: true` y `esTexto: true`, además de tokens, modelo, estado, duración y los IDs de conversación y mensaje cuando corresponden. El registro no duplica prompts, opciones ni respuestas. Comparte `LLM_MONTHLY_TEXT_QUERY_LIMIT` con las consultas de texto e imagen y reserva una consulta antes de enviar. Las negativas y errores de red conservan el cupo; los rechazos HTTP sin consumo siguen las reglas existentes. No se estiman precios monetarios: se guardan los totales de tokens informados por OpenAI.

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
