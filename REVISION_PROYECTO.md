# Revisión del proyecto y del trabajo entre máquinas

Fecha: 10 de octubre de 2026, Argentina.
Código revisado: `33bc6eb9ae031e3cfd8932172756ce6a16a66cc6` (`first commit`).

Al iniciar la revisión, la copia local y la rama `main` de GitHub coincidían en este commit. El proyecto es una base en desarrollo: el commit publicado no arrancó en esta máquina y todavía no implementa el recorrido completo WhatsApp → MongoDB → OpenAI → respuesta al cliente.

Esta revisión agrega únicamente este informe. No modifica la aplicación, sus dependencias, la configuración de Git ni las bases de datos. El informe queda local, pendiente de commit y push. Durante la revisión aparecieron cambios ajenos a esta auditoría en `package.json` y `package-lock.json`, que agregan `dotenv`; también apareció un archivo `.env`. Se conservaron esos cambios.

Actualización al cierre: `dotenv` está declarado como `^18.0.7`, está instalado en versión `18.0.7` y ambos manifiestos siguen coincidiendo. Esa corrección aún no forma parte del commit publicado revisado. No se leyó el contenido del nuevo `.env` ni se volvió a iniciar el servidor con él; su configuración y las conexiones reales quedan sin verificar.

## Alcance y resultados comprobados

- Se leyeron los 18 archivos versionados, incluidos el manifiesto, el lockfile, los servicios, los modelos, el frontend y el prompt de ejemplo.
- Al comenzar, `git status --short` estaba vacío. Hay una única rama local y una única rama publicada: `main`. Se consultó GitHub con `git ls-remote --heads origin`; su SHA coincide con `HEAD` y `origin/main` locales.
- Entorno local: Node.js `v24.15.0`, npm `11.12.1`. Mongoose instalado exige Node.js `>=20.19.0`; esta máquina cumple ese requisito.
- Los 12 archivos JavaScript pasan `node --check`. Esto verifica sintaxis, no funcionamiento.
- `package.json` y las dependencias de la raíz de `package-lock.json` coinciden. Al inicio, las dependencias directas declaradas estaban instaladas, pero `dotenv` no estaba declarado ni instalado. Al cierre se comprobó su incorporación local.
- `npm run iniciar` falló con `MODULE_NOT_FOUND: dotenv` en la primera línea de `index.js`, antes de la incorporación local de esa dependencia.
- Se ejecutaron 10 comprobaciones locales con respuestas simuladas para OpenAI, WhatsApp y esquemas de MongoDB. Se confirmaron los defectos detallados abajo y el funcionamiento del procesamiento básico de texto y de la verificación GET del webhook.
- Se hicieron tres comprobaciones adicionales: carga del JavaScript del frontend sin `$`, inicio de sesión sin `email` definido y parseo del JSON de ejemplo del prompt. Las tres reproducen errores.
- `npm audit --json` devolvió **0 vulnerabilidades conocidas** antes y después de la incorporación local de `dotenv`. Esto no certifica la seguridad de la lógica de la aplicación.
- No se detectaron claves con los patrones de búsqueda usados en los archivos del proyecto revisados antes de que apareciera el nuevo `.env`. La búsqueda fue limitada y no equivale a una auditoría exhaustiva de secretos.

Las comprobaciones funcionales no llamaron a OpenAI ni Meta y no conectaron a MongoDB. Se usaron valores ficticios de configuración únicamente dentro de los procesos de prueba. Las únicas consultas externas de la revisión fueron GitHub, el registro de npm y documentación oficial. No se comprobó el estado del disco de la otra máquina, sus cambios sin publicar, sus credenciales ni sus servicios.

## Errores y funciones pendientes

Las referencias de líneas corresponden al commit revisado. Los defectos en módulos que aún no se importan desde el servidor son fallos latentes; no explican el error de arranque actual.

| Prioridad | Ubicación | Hallazgo y efecto | Acción recomendada |
| --- | --- | --- | --- |
| Alta, corregida localmente | `index.js:1`, `package.json:13` | El commit publicado requiere `dotenv`, pero no lo declara. Se reprodujo el fallo de arranque. Durante la revisión se incorporó localmente a ambos manifiestos y se instaló. | Revisar y publicar la corrección existente; verificar después el arranque con un entorno de prueba. |
| Alta | `services/whatsapp.js:34`, `services/orquestador.js:1` | Un webhook con firma válida obtiene HTTP 200, pero se pasa `{}` al orquestador, que está vacío. No se procesan ni guardan los mensajes. | Pasar y validar el contenido recibido e implementar el recorrido mínimo de texto y su persistencia. |
| Alta | `services/whatsapp.js:20` | `Buffer.from(req.rawBody)` se ejecuta antes de comprobar que existe el cuerpo capturado. Una petición que no pase por el parser JSON puede provocar un error. | Validar cuerpo y tipo de contenido antes de convertirlos. |
| Alta | `services/whatsapp.js:22` | Si falta la firma o su prefijo es incorrecto, el controlador retorna `false` sin enviar una respuesta HTTP. La petición queda pendiente. | Responder con un estado de rechazo explícito en todas las rutas de validación. |
| Alta | `services/openai.js:92` | `procesarAudio` usa `duracionAudio`, que no está definido ni importado. Falla antes de llamar a la API. | Definir cómo se mide la duración y consolidar la ruta de transcripción. |
| Alta | `services/openai.js:144` | `transcribirAudio` devuelve `segundosAudio`, que no existe en su alcance. Incluso una transcripción exitosa termina en `ReferenceError`. | Obtener la duración con un método definido o ajustar el contrato de retorno. |
| Alta | `services/openai.js:158` | La búsqueda web pasa `{consultasTexto: 1, webSearch: 1}` como segundo argumento de `consultarOpenAI`, donde se espera un `AbortSignal`. `AbortSignal.any` lanza `ERR_INVALID_ARG_TYPE` antes de enviar la solicitud. | Pasar la señal de cancelación y gestionar las cuotas en una capa específica. |
| Alta | `models/usuarios.js:13`, `models/uso.js:23` | Ambos archivos registran el modelo `Uso` con esquemas diferentes. Importarlos en el mismo proceso provoca `OverwriteModelError`. | Dar al modelo de usuarios su identidad y colección propias. Antes de cambiar nombres en un despliegue existente, comprobar los datos almacenados. |
| Media | `services/openai.js:80` | `procesarImagen` recibe opciones, pero omite las instrucciones, el modo JSON y la señal de cancelación del llamador. | Unificar el contrato de opciones con el procesamiento de texto. |
| Media | `models/conversacion.js:40`, `models/uso.js:22`, `models/usuarios.js:12` | Se declara un índice sobre `conversacionId` en esquemas que no contienen ese campo. El índice de usuarios tampoco corresponde a sus datos. | Definir índices según las consultas reales y las relaciones que se vayan a persistir. |
| Baja | `models/conversacion.js:5` | `deClienteParaSistema` está declarado dos veces; JavaScript conserva una sola definición. | Eliminar la duplicación y definir una representación inequívoca de la dirección. |
| Pendiente | `index.js:26`, `public/index.html`, `public/index.js`, `services/usuarios.js`, `services/sockets.js` | Solo se registran dos rutas de webhook. No se sirve el frontend ni existen las rutas de sesión/conversaciones que este solicita. El HTML está vacío, no carga scripts ni jQuery; el login usa `email` y `contrasena` sin definir. Usuarios tiene funciones vacías y sockets está vacío. | Implementar el panel y su backend por una tarea separada, con autenticación y protección de las rutas. |
| Pendiente | `.env-example`, `services/openai.js`, `models/uso.js` | Los límites mensuales y `WAIT_BETWEEN_MESSAGES` se declaran, pero ningún código los aplica. Tampoco se guardan registros de uso. `max_tool_calls: 1` no implementa una cuota mensual. | Reservar y registrar consumos de forma consistente; incorporar agrupación de mensajes y control de concurrencia cuando exista el orquestador. |
| Pendiente | `models/mensaje.js`, `services/whatsapp.js` | No hay deduplicación persistente por identificador de mensaje, cola durable ni manejo de fallos del procesamiento posterior al HTTP 200. | Al implementar el flujo, evitar procesar dos veces un mensaje y definir cómo recuperar fallos después de confirmarlo. |
| Media | `prompts/PROMPT_MAESTRO_EXAMPLE.md:20`, `:42` | Los ejemplos contienen valores vacíos, una comilla sin cerrar y una coma final. El ejemplo de salida falla con `JSON.parse`. | Usar ejemplos de JSON válido y validar herramienta/parámetros antes de ejecutar acciones. |

La verificación HMAC sí utiliza el cuerpo original y comparación con `timingSafeEqual`. El GET de verificación acepta el token correcto y rechaza uno incorrecto en las pruebas locales. La petición de texto de OpenAI construye el payload esperado y extrae texto y tokens de una respuesta simulada. Estos puntos positivos no sustituyen una prueba de integración real.

## Configuración y reproducibilidad

Al inicio no existía `.env`; al cierre apareció uno que no se inspeccionó. Git ignora `.env`, `node_modules` y `uploads`, por lo que son recursos locales que deben prepararse en cada máquina. MongoDB local también tendrá sus propios datos: compartir el código no comparte la base.

La plantilla presenta diferencias con la implementación: describe `WHATSAPP_APP_SECRET` como recomendado para producción, pero el webhook lo exige siempre; anuncia protección de `/api/messages` con `INTERNAL_API_KEY`, aunque esa ruta no existe y la clave no se usa. `transcribirAudio` lee `OPENAI_TRANSCRIPTION_MODEL`, que no figura en la plantilla, mientras `OPENAI_AUDIO_MODEL` corresponde a otra función. Conviene reconciliar código, plantilla y documentación.

`.gitignore` no cubre `.env.local` ni `.env.production`: se comprobó con `git check-ignore`. Si se van a usar variantes, ignorar `.env.*` y preservar expresamente las plantillas públicas. No subir credenciales para facilitar la sincronización.

Faltan README, instrucciones compartidas `AGENTS.md`, versión de Node/npm fijada, tests automatizados y CI. Los scripts `crear-usuario` y `deshabilitar-usuario` están vacíos. Como propuesta, acordar Node 24.x y documentar las versiones probadas; la versión actual de esta máquina cumple los requisitos instalados. Usar `npm ci` desde el lockfile en cada clon después de publicar y traer la corrección de `dotenv`; no copiar `node_modules` entre sistemas operativos. Un `npm ci` basado únicamente en el commit publicado revisado no resuelve ese fallo de arranque.

Para el bot, decidir expresamente cómo se construirá el contexto: resumen e historial guardados por la aplicación o estado de conversación de la API. La función de texto actual recibe solo el `input` entregado por el llamador y aún no hay orquestador que componga ese contexto. OpenAI documenta ambas formas en [estado de conversación](https://developers.openai.com/api/docs/guides/conversation-state).

Para transcribir archivos, consolidar preferentemente la implementación existente de `/audio/transcriptions` y validar formatos y contrato antes de incorporar otra ruta. La [guía oficial de transcripción](https://developers.openai.com/api/docs/guides/speech-to-text) describe ese flujo. La disponibilidad efectiva del modelo configurado en la cuenta no se verificó.

## Flujo propuesto para las dos máquinas

El usuario confirmó que comparte cambios mediante commits y push a GitHub. Ese flujo permite continuar desde cualquier clon, pero cada transición necesita publicar y traer los commits. La comprobación de hoy demuestra coincidencia con GitHub, no que la otra máquina haya publicado todo su trabajo.

### Al empezar en una máquina

1. Confirmar la carpeta, la rama y los cambios locales. Si hay cambios, preservarlos y revisarlos antes de cambiar de rama o integrar novedades.

   ```powershell
   git status --short
   git branch --show-current
   git fetch origin
   git branch -vv
   git log -1 --oneline
   ```

2. En la rama de trabajo correcta y con el árbol limpio, traer su upstream:

   ```powershell
   git pull --ff-only
   ```

   Si falla por divergencia, revisar los commits de ambos lados y resolverla de forma explícita. No usar un reset o un push forzado como solución automática.

3. Verificar Node/npm, instalar dependencias desde el lockfile cuando corresponda y configurar `.env` y MongoDB en esa máquina. Antes de probar webhooks reales, identificar cuál instancia recibe los eventos de Meta y qué base usa.

### Al terminar o cambiar de máquina

1. Revisar el diff, ejecutar las comprobaciones relevantes y agregar únicamente los archivos previstos.
2. Crear un commit y publicarlo en su rama. Confirmar que el push terminó correctamente.
3. Registrar en documentación versionada la rama, el último commit, qué funciona, qué falta y qué pruebas se hicieron, sin secretos.
4. En la siguiente máquina, repetir la actualización inicial antes de continuar.

Para tareas nuevas, usar una rama por cambio, por ejemplo `codex/corregir-webhook`, basada en un `main` actualizado. Si se continúa la misma tarea de forma secuencial, ambas máquinas pueden usar esa rama en sus clones separados, alternando push/pull. Si ambas trabajan a la vez, usar ramas distintas y revisar su integración mediante PR; evitar que dos sesiones modifiquen simultáneamente la misma rama publicada.

En una misma máquina, un worktree de Codex puede aislar tareas. Su documentación contempla trabajar, crear una rama, publicar commits y abrir un PR desde él; el worktree no sustituye el intercambio por GitHub entre clones. Véase [documentación oficial de worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees).

Propuesta para compartir la forma de trabajar: un `README.md` con instalación, configuración y comandos; un `AGENTS.md` con mapa del proyecto, idioma, alcance de cada servicio y validaciones; y un registro breve del estado de la tarea. Las decisiones necesarias para continuar deben quedar en archivos publicados, además de la conversación con Codex.

## Orden recomendado de las siguientes tareas

1. Revisar y publicar la incorporación local de `dotenv`, verificar el arranque y preparar un entorno de desarrollo reproducible en ambos clones.
2. Corregir los errores determinísticos de webhook, audio, búsqueda web y modelos; agregar pruebas de regresión para ellos.
3. Implementar y verificar el recorrido mínimo de un mensaje de texto, con persistencia y deduplicación.
4. Añadir contexto, herramientas comerciales, límites de uso y agrupación de mensajes.
5. Implementar autenticación, panel y sockets, y después verificar el conjunto con servicios reales de prueba.

Esta revisión no acredita funcionamiento integral: la configuración local nueva no se verificó y faltan partes sustanciales de la aplicación. MongoDB, el envío real de WhatsApp, la cuenta de OpenAI y el entorno de la otra máquina requieren comprobaciones posteriores.
