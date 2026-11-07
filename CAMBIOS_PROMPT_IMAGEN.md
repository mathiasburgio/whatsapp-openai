# Cambios para el prompt de respuesta en producción

Aplicar estos cambios al Markdown de la etapa `respuesta` (`RESPUESTA.md`). No hace falta modificar el orquestador: la acción sigue siendo `buscar_vehiculo` y la respuesta elige si adjunta una foto. Los archivos de `prompts/` no se modificaron.

## 1. Reemplazar la forma del JSON

Reemplazar la instrucción que exige únicamente `{"mensaje":"Texto para el cliente"}` por:

```text
Devolvé un JSON con la forma {"mensaje":"Texto para el cliente","imagenUrl":null}. mensaje contiene el texto que recibirá el cliente. imagenUrl contiene la URL exacta de la foto del catálogo que se adjuntará, o null cuando no corresponda enviar una imagen.
```

## 2. Agregar estas reglas

```text
- Cuando presentes u ofrezcas una moto concreta de catalogo.vehiculos, adjuntá su foto en imagenUrl: usá la url de fotos con portada: true; si no hay portada, usá la primera foto válida de esa moto. Copiá la URL exactamente, sin construirla ni modificarla. La foto debe pertenecer a esa misma moto y al catálogo consultado en este turno. Si no hay una foto disponible, usá imagenUrl: null.
- Incluí el enlace de la publicación en mensaje cuando esté informado, además del precio y la moneda cuando estén disponibles. La URL de la foto va únicamente en imagenUrl; no reemplaza el enlace de la publicación. La foto se enviará como imagen adjunta y mensaje será su pie de imagen, sin depender de la previsualización del enlace.
- Si imagenUrl no es null, mensaje debe tener entre 1 y 1024 caracteres, incluido el enlace. Si imagenUrl es null, mensaje puede tener entre 1 y 3500 caracteres.
- En saludos, consultas generales o comparaciones sin una moto principal claramente identificada, usá imagenUrl: null. Si presentás varias motos y hay una opción principal clara, adjuntá únicamente la foto de esa opción e identificá en el texto a qué moto corresponde. No prometas adjuntar varias fotos.
```

Reemplazar también cualquier regla anterior que indique un límite incondicional de 3500 caracteres por el límite condicional de arriba, para que no se contradigan.

## Comportamiento del código

- La respuesta estructurada requiere `mensaje` e `imagenUrl`. La URL elegida se valida contra `vehiculo.fotos` del resultado actual antes del envío.
- WhatsApp recibe un único mensaje `type: "image"` con `image: { link, caption }` y el contexto del mensaje al que se responde. Si `imagenUrl` es null, se conserva el envío de texto.
- La foto debe ser pública y accesible para Meta, en JPEG o PNG. La validación local comprueba la URL y su pertenencia al catálogo; no descarga la foto para comprobar su formato o disponibilidad. Los errores de entrega posteriores se manejan con el webhook existente.
- Un fallo sin confirmación de Meta mantiene el estado `envio_incierto` y no se reintenta automáticamente.
