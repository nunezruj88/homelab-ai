# Prueba de Cloudflare con adaptador de contenido

## Qué sabemos

El 9 de septiembre de 2026, Qwen respondió a consultas directas y solicitó
herramientas. Un historial ficticio con `assistant.content: ""` funcionó, mientras
que otro con `assistant.content: null` devolvió HTTP 400 (código 5006).
OpenClaw 2026.9.3 también falló en la segunda petición incluso con
`requiresStringContent: true`. El cuerpo enviado por OpenClaw aún no se ha
capturado: no está confirmado que el valor nulo sea su único problema.

En la prueba real, el adaptador permitió completar la llamada MCP. Después se
observó que desaparecían las cifras incluso sin herramientas. La captura directa
de Cloudflare confirmó nueve fragmentos `delta.content` numéricos (por ejemplo
`1` en lugar de `"1"`). Al conservar solo texto se obtiene `CPU .%, RAM .%, nodos .`;
al convertir esos fragmentos se recupera `CPU 12.34%, RAM 56.78%, nodos 4.`.

Este experimento cambia `content: null` a `content: ""` en mensajes
`assistant` con una lista no vacía de `tool_calls`. Conserva orden, IDs,
argumentos, resultados y campos adicionales. En respuestas SSE convierte únicamente
los valores numéricos finitos de `choices[].delta.content` a texto, incluido cero.
No convierte arrays, no modifica herramientas y no hace reintentos.
Los cuerpos JSON y los eventos SSE sin cambios se conservan. El streaming acumula
como máximo un evento (límite de 1 MiB), no toda la respuesta.

El adaptador solo acepta el modelo `@cf/qwen/qwen3-30b-a3b-fp8` y un endpoint fijo
de Cloudflare. El bearer token existente de OpenClaw se reenvía por HTTPS a
Cloudflare, que valida sus permisos; el adaptador no almacena una copia.
El salto OpenClaw-adaptador es HTTP dentro de la red Docker dedicada, sin puertos
publicados. No conectes contenedores no confiables a esa red.
Los logs contienen únicamente estado HTTP, número de mensajes normalizados y
latencia hasta las cabeceras. Al terminar SSE registran `streamComplete` y
`normalizedContentChunks`; no incluyen cuerpos, URLs de cuenta ni tokens.

## Desplegar desde la raíz del repositorio

En `config/secrets/runtime.env`, añade tu Account ID (32 caracteres hexadecimales):

```dotenv
CLOUDFLARE_ACCOUNT_ID=TU_ACCOUNT_ID
```

No añadas el token aquí: usa el que ya guardaste en el perfil de autenticación
`cloudflare-test` de OpenClaw.

```bash
unset CLOUDFLARE_ACCOUNT_ID
docker compose --env-file config/secrets/runtime.env \
  -f docker/cloudflare-adapter/docker-compose.yml config --quiet
docker compose --env-file config/secrets/runtime.env \
  -f docker/cloudflare-adapter/docker-compose.yml up -d --build
docker compose --env-file config/secrets/runtime.env \
  -f docker/cloudflare-adapter/docker-compose.yml ps
```

La imagen se construye desde `node:24-bookworm-slim`, una etiqueta de mantenimiento
de Node 24, no un digest inmutable. No requiere paquetes npm.
El contenedor se ejecuta como usuario `node`, sin capacidades, con filesystem
de solo lectura y límites de memoria y procesos. Usa la red `mcp-net` ya existente.
`/healthz` comprueba solo el adaptador, no credenciales ni disponibilidad de Cloudflare.

## Actualizar un adaptador ya instalado

Desde la raíz del repositorio:

```bash
git pull --ff-only
unset CLOUDFLARE_ACCOUNT_ID
docker compose --env-file config/secrets/runtime.env \\
  -f docker/cloudflare-adapter/docker-compose.yml up -d --build --force-recreate
```

Si el proveedor ya apunta a `http://cloudflare-adapter:8080/v1`, basta con
recrear el adaptador. Prueba en una sesión nueva:

```bash
docker exec -it openclaw openclaw agent \\
  --agent cloudflare-test \\
  --session-id "$(cat /proc/sys/kernel/random/uuid)" \\
  --message "Sin usar herramientas, copia exactamente: CPU 12.34%, RAM 56.78%, nodos 4."
```

Después consulta los nodos y contrasta las cifras con Proxmox.

## Conectar únicamente el proveedor de prueba

Requiere el agente y proveedor `cloudflare-test` ya configurados con Qwen, su
token propio y la lista `proxmox__*`, `grafana__*`, `session_status`.
No cambies Moonshot ni el agente `homelab-observer`.

```bash
docker exec openclaw openclaw config set --batch-json \
  '[{"path":"models.providers.cloudflare-test.baseUrl","value":"http://cloudflare-adapter:8080/v1"}]'
docker restart openclaw
docker exec -it openclaw openclaw agent \
  --agent cloudflare-test \
  --session-id "$(cat /proc/sys/kernel/random/uuid)" \
  --message "Usa Proxmox MCP para consultar el estado de los nodos. Resume los datos reales en español, sin ejecutar cambios."
docker logs --tail 20 cloudflare-adapter
```

Si la prueba pasa, repite con una sesión nueva y solicita además los dashboards
de Grafana. Que exista un resumen no basta: confirma que contiene datos actuales
y que las llamadas MCP finalizaron correctamente.

Interpretación:
- `normalizedContentChunks > 0`: se recuperaron fragmentos numéricos del streaming.
- `streamComplete: false`: el streaming se interrumpió; no des por completo el informe.
- `normalized: 1` o superior: el adaptador recibió y corrigió mensajes con nulos.
- `upstreamStatus: 200`: Cloudflare aceptó esa petición; comprueba también que
  OpenClaw termine sin error y con resultados de herramientas.
- `normalized: 0` y HTTP 400: el caso que corrige este adaptador no apareció.
- `normalized > 0` y HTTP 400: la corrección no es suficiente.
- HTTP 502: fallo de conexión o tiempo máximo de 120 segundos.
- HTTP 413: petición superior a 8 MiB.
No actives logs completos de peticiones para diagnosticar: pueden incluir
credenciales y datos del homelab.

Los metadatos de coste a cero en un proveedor personalizado de OpenClaw no
significan que Workers AI sea gratuito. Consulta el consumo real en Cloudflare.

## Volver a conexión directa

Sustituye `TU_ACCOUNT_ID` antes de ejecutar:

```bash
docker exec openclaw openclaw config set --batch-json \
  '[{"path":"models.providers.cloudflare-test.baseUrl","value":"https://api.cloudflare.com/client/v4/accounts/TU_ACCOUNT_ID/ai/v1"}]'
docker restart openclaw
docker compose --env-file config/secrets/runtime.env \
  -f docker/cloudflare-adapter/docker-compose.yml down
```

Esto retira únicamente el adaptador. No elimina la red externa ni el volumen de
OpenClaw.

## Validación

```bash
node --test docker/cloudflare-adapter/server.test.mjs
```

Las pruebas usan un servidor local ficticio: transformación acotada e idempotente,
preservación de datos, reenvío de autenticación, SSE incremental, errores sin
reintentos, timeout, límites y ausencia de contenidos en logs.
La captura real se reprodujo localmente y recuperó todas las cifras sin alterar
otros campos. Tras desplegar, queda verificar la respuesta visible en OpenClaw.
