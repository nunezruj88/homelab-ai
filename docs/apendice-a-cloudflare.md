# Apéndice A — Investigación pendiente: Cloudflare Workers AI + LiteLLM

## Estado: investigación retomada, integración aún no resuelta

Actualización 2026-09-09: las peticiones directas sin LiteLLM pasan para chat,
solicitud de herramienta y devolución de resultado con contenido de texto vacío.
Una prueba con `assistant.content: null` falla con HTTP 400. En OpenClaw 2026.9.3
persiste el rechazo de la segunda petición incluso con `requiresStringContent`.
Todavía no hemos inspeccionado el cuerpo exacto de esa petición; los mensajes
`oneOf` no identifican por sí solos la causa única.

El [adaptador experimental](cloudflare-adapter.md) permitió completar una consulta
MCP al corregir ese valor nulo. Una segunda incompatibilidad quedó confirmada en
una captura directa: Cloudflare entrega algunos `delta.content` como números y
la respuesta visible pierde las cifras. El adaptador ahora convierte esos valores
a texto; la reproducción local recupera las cifras y falta validar el despliegue. La evidencia histórica que sigue se conserva como registro, no
como confirmación de la causa actual ni de un fallo general de Workers AI.

Se intentó usar Cloudflare Workers AI (modelo `qwen3-30b-a3b-fp8`, que sí soporta function calling nativamente según la documentación de Cloudflare) a través de LiteLLM como proxy OpenAI-compatible, como cerebro para OpenClaw.

## Síntoma

Tool-calling en un **único turno** funcionaba correctamente (respuesta con `tool_calls` bien formado). Pero **cualquier conversación multi-turno que incluyera un resultado de herramienta en el historial** fallaba de forma consistente con:

```
AiError: Bad input: Error: oneOf at '/' not met, 0 matches: required properties at '/' are 'prompt',
Type mismatch of '/messages/0/content', 'array' not in 'string', ...
```

## Combinaciones probadas (todas con el mismo error)

- Proveedor nativo `cloudflare/` de LiteLLM
- Endpoint OpenAI-compatible de Cloudflare (`openai/` + `api_base` apuntando a `/ai/v1`)
- Con y sin streaming (probado con `fake_stream: true` en LiteLLM, para forzar no-streaming hacia Cloudflare aunque el cliente pida streaming)
- Con y sin `modify_params` / `drop_params` en `litellm_settings`
- Con el flag `compat.requiresStringContent: true` en la config de modelo de OpenClaw — este flag existe específicamente para backends que solo aceptan `content` como string plano, no como array de bloques. Documentado oficialmente para este exacto escenario, pero no resolvió el caso con Cloudflare.

## Evidencia de que es un bug del lado de Cloudflare

Se encontraron reportes de al menos otros dos proyectos completamente independientes (`opencode`, `OmniRoute`) con el **mismo error exacto** contra Cloudflare Workers AI en las mismas condiciones (tool-calling + multi-turno). Esto apunta a un bug en el validador de esquema del lado de Cloudflare, no a algo específico de nuestra configuración de LiteLLM/OpenClaw.

## Para retomar esta investigación

1. Comprobar si Cloudflare ha corregido el bug (buscar changelog/issues recientes de Workers AI).
2. La config de partida está en `docker/litellm/config.yaml` y `docker/litellm/docker-compose.yml` de este repo.
3. Pistas no exploradas del todo:
   - Probar con otros modelos de Cloudflare con function calling (no solo la familia Qwen3) — no confirmado si el bug es específico del modelo o genérico de la plataforma.
   - Probar sin pasar por LiteLLM en absoluto — un cliente OpenAI-SDK puro contra el endpoint de Cloudflare, para descartar cualquier interferencia de LiteLLM en la serialización.
   - Contactar soporte/Discord de Cloudflare Workers AI con el error exacto y el ID de request que devuelve cada fallo (viene en el propio JSON de error).

## Solución adoptada mientras tanto

El stack en producción usa **Kimi (Moonshot AI) de forma nativa en OpenClaw**, sin pasar por LiteLLM ni por Cloudflare. Funciona correctamente en multi-turno con tool-calling sin ningún workaround.
