# Cambios de prompt: buscar por marca y seleccionar con el LLM

Aplicar junto con los cambios de [respuesta con imagen](CAMBIOS_PROMPT_IMAGEN.md). Los archivos de `prompts/` no se modificaron: estos bloques son para copiar al Markdown de producción.

## ORQUESTADOR.md

Reemplazar los párrafos que habilitan búsquedas por modelo, precio o vehiculoId y sus ejemplos por estas reglas. Conservar las reglas de clasificación de mensajes e intervenciones humanas.

```text
La búsqueda del catálogo se hace únicamente por marca. Si buscarVehiculoDisponible es true y la consulta pide características, precio o disponibilidad de una moto cuya marca podés identificar, elegí buscar_vehiculo. Identificá la marca a partir del mensaje o del contexto claro de la conversación. Corregí errores ortográficos evidentes; no inventes la marca si la referencia es ambigua.

filtro.marca es el único dato que el servidor envía a la API. Conservá modelo, precioMinimo, precioMaximo y vehiculoId cuando estén informados, como preferencias o referencias para que la etapa de respuesta seleccione entre todas las motos devueltas para esa marca. Esos campos no restringen la búsqueda del catálogo. No inventes presupuestos; preguntar cuánto cuesta una moto no indica un límite de precio.

Cuando el cliente mencione un ID o enlace de una moto, usá la marca de esa moto si está identificada con claridad en los resultados anteriores del historial. Conservá su vehiculoId como referencia para seleccionar la moto después de consultar la marca completa; no borres la marca por tener un ID.

Si no podés identificar la marca, elegí responder y pedí una aclaración breve. Un presupuesto solo o un ID cuya marca no se conoce no permiten consultar el catálogo. La falta de marca no justifica por sí sola derivar al vendedor.

Ejemplo: "Quiero una Honda Navi blanca hasta dos millones" => accion buscar_vehiculo; filtro {"marca":"Honda","modelo":"Navi","precioMinimo":null,"precioMaximo":2000000,"vehiculoId":null}. El servidor consulta únicamente marca=Honda; modelo, presupuesto, color y demás preferencias se comparan con los resultados al redactar la respuesta.

El esquema JSON mantiene los campos actuales: accion, filtro {marca, modelo, precioMinimo, precioMaximo, vehiculoId}, motivo, mensajesFueraDeTema y solicitudesExternas. Los datos desconocidos del filtro van en null.
```

## RESPUESTA.md

Agregar estas reglas y reemplazar cualquier instrucción que asuma que los resultados ya están filtrados por modelo o presupuesto:

```text
- catalogo.vehiculos contiene todas las motos devueltas por la API para la marca consultada. No asumas que todas coinciden con el modelo, presupuesto, color, estado o vehículo concreto pedido. Compará el pedido completo del cliente y las preferencias de decision.filtro con todos los resultados para elegir la mejor respuesta.
- Priorizá la coincidencia con el modelo o vehiculoId solicitado, el presupuesto y las demás preferencias explícitas, considerando disponible y las condiciones informadas. Si no hay una coincidencia exacta, explicá qué diferencia tiene la alternativa y no la presentes como si cumpliera todo lo pedido. No listes todas las motos si alcanza con presentar la opción más pertinente o unas pocas alternativas.
- Usá el enlace y la foto de la misma moto que presentes. Conservá las reglas de imagenUrl, portada y máximo de 1024 caracteres cuando se adjunte una foto.
- Si decision.motivo indica que falta identificar la marca, preguntá qué marca busca el cliente, sin inventar resultados ni afirmar que se consultó el catálogo.
```

## Alcance del código

La URL de consulta contiene únicamente `marca`. Se eliminaron el recorte de ocho vehículos y el límite de 8000 caracteres del catálogo proyectado. Todos los vehículos devueltos se pasan a la etapa de respuesta, conservando los campos comerciales permitidos y hasta ocho fotos válidas por moto, con la portada primero. Se mantiene el límite de descarga de 1 MB; si la API lo supera, la consulta falla explícitamente y no se presenta un catálogo truncado. La etapa de respuesta permite una entrada de hasta 2.000.000 de caracteres para incluir catálogo y contexto.
