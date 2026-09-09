# Homelab IA

Stack de IA agentic autoalojado sobre Proxmox. OpenClaw usa Kimi/Moonshot como
modelo y consume Proxmox, Grafana, Home Assistant y Node-RED mediante MCP.

```text
                         ┌─ Proxmox MCP (solo lectura) ── Proxmox API
OpenClaw ── MCP HTTP ────┼─ Grafana MCP (solo lectura) ── Grafana API
                         ├─ Home Assistant MCP
                         └─ Node-RED MCP
```

OpenClaw no tiene acceso al socket Docker. Proxmox MCP funciona como servicio
independiente con transporte Streamable HTTP, herramientas `read` y un token
`PVEAuditor`. Consulta [el diseño del plano de control](docs/arquitectura-mcp.md).

> Cloudflare Workers AI + LiteLLM se probaron y se aparcaron por un problema de
> tool-calling multi-turno. El stack activo usa Moonshot de forma nativa. Consulta
> [el apéndice de Cloudflare](docs/apendice-a-cloudflare.md).

## Estructura

```text
homelab-ai/
├── config/
│   ├── mcp/catalog.yaml             # inventario y política de los MCP
│   └── secrets/runtime.env.example  # plantilla única; runtime.env no se versiona
├── docker/
│   ├── mcp/docker-compose.yml       # Proxmox MCP + Grafana MCP
│   ├── openclaw/docker-compose.yml
│   ├── litellm/                     # investigación aparcada
│   └── portainer/
├── scripts/
│   ├── 01-crear-lxc.sh
│   ├── 02-onboard-openclaw.sh
│   ├── 03-registrar-mcps.sh
│   └── 04-crear-automatizaciones.sh
└── docs/
```

## 0. Prerrequisitos

- Proxmox VE accesible por HTTPS.
- Docker Engine y Docker Compose plugin dentro del LXC.
- Cuenta Moonshot y API key.
- Grafana 9 o posterior con una service account `Viewer`.
- Certificado de confianza en la API Proxmox. Para un laboratorio sin PKI se
  puede usar temporalmente `PROXMOX_VERIFY_SSL=false`.
- Home Assistant y Node-RED son opcionales.

Cada bloque debe desplegarse y verificarse antes de continuar.

## 1. Crear el LXC

Revisa las variables al principio del script y ejecútalo en el host Proxmox:

```bash
scripts/01-crear-lxc.sh
```

Dentro del LXC:

```bash
ip a show eth0
ping -c 3 10.8.1.1
```

## 2. Instalar Docker

Dentro del LXC:

```bash
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose-plugin
docker --version
docker compose version
systemctl is-active docker
```

## 3. Preparar redes y secretos

Desde la raíz del repositorio:

```bash
docker network inspect ia-net >/dev/null 2>&1 || docker network create ia-net
docker network inspect mcp-net >/dev/null 2>&1 || docker network create mcp-net

cp config/secrets/runtime.env.example config/secrets/runtime.env
nano config/secrets/runtime.env
```

Genera tokens distintos:

```bash
openssl rand -hex 32  # OPENCLAW_GATEWAY_TOKEN
openssl rand -hex 32  # GRAFANA_MCP_SERVER_TOKEN
```

`runtime.env` está ignorado por Git. No lo copies a incidencias, logs o capturas.

## 4. Crear credenciales de solo lectura

### Proxmox

Usa un usuario y token dedicados, con separación de privilegios:

```bash
pveum user add mcp@pve
pveum acl modify / --users mcp@pve --roles PVEAuditor
pveum user token add mcp@pve mcp --privsep 1
pveum acl modify / --tokens 'mcp@pve!mcp' --roles PVEAuditor
pveum user token permissions mcp@pve mcp
```

Copia el secret generado a `PROXMOX_TOKEN_VALUE`.

### Grafana

Crea una service account con rol `Viewer` y guarda su token en
`GRAFANA_SERVICE_ACCOUNT_TOKEN`. `GRAFANA_MCP_SERVER_TOKEN` es un segundo token
aleatorio que autentica a OpenClaw frente al propio servidor MCP.

## 5. Desplegar los MCP

```bash
docker compose --env-file config/secrets/runtime.env \
  -f docker/mcp/docker-compose.yml config --quiet
docker compose --env-file config/secrets/runtime.env \
  -f docker/mcp/docker-compose.yml up -d
```

Los servicios solo usan `mcp-net`; sus puertos no se publican en el host.

## 6. Desplegar y configurar OpenClaw

```bash
docker compose --env-file config/secrets/runtime.env \
  -f docker/openclaw/docker-compose.yml config --quiet
docker compose --env-file config/secrets/runtime.env \
  -f docker/openclaw/docker-compose.yml up -d

scripts/02-onboard-openclaw.sh
```

El gateway se publica en `127.0.0.1:18789` por defecto. Si debe ser accesible
desde la LAN, configura `OPENCLAW_GATEWAY_HOST` con la IP concreta del LXC y
protege el acceso con firewall o proxy. No publiques directamente los MCP.

Verificación:

```bash
curl -fsS http://127.0.0.1:18789/healthz
curl -fsS http://127.0.0.1:18789/readyz
```

### Acceso web desde la LAN y aprobación del navegador

En `config/secrets/runtime.env`, establece `OPENCLAW_GATEWAY_HOST` con la IP
del LXC. En el homelab probado:

```dotenv
OPENCLAW_GATEWAY_HOST=10.8.1.101
```

Desde la raíz del repositorio, elimina cualquier valor de esa variable exportado
en la terminal que pueda sobrescribir el archivo y recrea el contenedor:

```bash
unset OPENCLAW_GATEWAY_HOST
docker compose --env-file config/secrets/runtime.env \
  -f docker/openclaw/docker-compose.yml up -d --force-recreate openclaw
docker port openclaw 18789
```

La salida debe mostrar `10.8.1.101:18789` (o la IP que hayas configurado).
Comprueba la salud usando esa misma IP y abre la interfaz:

```bash
curl -fsS http://10.8.1.101:18789/healthz
```

Abre [OpenClaw en el homelab](http://10.8.1.101:18789/). Sustituye la IP si tu
LXC usa otra dirección. Para obtener el token de acceso, ejecuta en el LXC:

```bash
docker exec -it openclaw openclaw gateway auth-token --show
```

Introduce ese token en la interfaz web. Este comando muestra un secreto:
úsalo solo para iniciar sesión y no publiques su salida.

Si el navegador solicita aprobación del dispositivo, lista las solicitudes:

```bash
docker exec -it openclaw openclaw devices list
```

Identifica la solicitud pendiente de tu navegador y aprueba su ID:

```bash
docker exec -it openclaw openclaw devices approve <ID_DE_SOLICITUD>
```

Sustituye `<ID_DE_SOLICITUD>` por el ID mostrado en tu solicitud actual; no es
un valor fijo. Vuelve al navegador y reconecta o recarga la página. Un navegador
o perfil nuevo puede requerir otra aprobación.

## 7. Configurar el modelo

```bash
docker exec -it openclaw openclaw configure
docker exec openclaw openclaw config set --batch-json \
  '[{"path":"models.providers.moonshot.baseUrl","value":"https://api.moonshot.ai/v1"},{"path":"models.providers.moonshot.api","value":"openai-completions"},{"path":"models.providers.moonshot.models","value":[{"id":"kimi-k2.6","name":"Kimi K2.6"}]}]'
docker exec -it openclaw openclaw models auth paste-api-key --provider moonshot
docker exec openclaw openclaw models set moonshot/kimi-k2.6
docker exec openclaw openclaw models status
```

Obtén la API key en [Kimi API Platform](https://platform.kimi.ai). El proveedor
sigue siendo `moonshot` y la URL internacional es `https://api.moonshot.ai/v1`.
Pega la clave únicamente en el asistente interactivo. El bloque anterior configura
Kimi K2.6 como única entrada de la lista de modelos Moonshot; si tienes otros modelos
personalizados, consérvalos al editar esa lista.

Después de configurar el proveedor:

```bash
docker restart openclaw
docker exec -it openclaw openclaw tui
```

Prueba primero un saludo y después consultas de lectura a Proxmox y Grafana.
Si aparece un aviso de memoria por falta de clave OpenAI, diagnostícalo por
separado: la clave Moonshot no configura el proveedor de embeddings.

La arquitectura MCP no depende del proveedor. El modelo se puede sustituir sin
cambiar los servidores ni sus credenciales.

## 8. Registrar y verificar MCP

```bash
scripts/03-registrar-mcps.sh
```

El script comprueba salud, registra las URLs internas y ejecuta `mcp doctor
--probe`. La cabecera de Grafana se guarda como referencia a una variable de
entorno, no como token literal.

## 9. Instalar la automatización inicial

```bash
scripts/04-crear-automatizaciones.sh
```

Crea `homelab-health-daily` a las 08:00 de `AUTOMATION_TZ`. Se ejecuta en una
sesión aislada mediante el agente `homelab-observer`. Su allowlist contiene
únicamente `proxmox__*`, `grafana__*` y `session_status`: no dispone de shell,
filesystem, navegador, mensajería ni otros MCP. No entrega resultados fuera de
OpenClaw hasta que se configure un destino explícito.

Prueba y revisa el resultado antes de activar entrega:

```bash
docker exec openclaw openclaw automations list --all
docker exec openclaw openclaw automations run <job-id> --wait
```

## 10. Home Assistant y Node-RED

### HA-MCP comunitario

Usa la URL de conexión completa que muestra HA-MCP, no un token de acceso de
Home Assistant añadido a la URL del puerto 8123.

- App/add-on: consulta sus registros y copia la URL de acceso directo
  (`MCP Server URL`). El puerto habitual es 9583.
- Componente personalizado: consulta la pantalla Configurar del servidor HA-MCP.
  El puerto habitual es 9584.
- Respeta el puerto y la ruta `/private_...` de tu instalación. La URL es una
  credencial; no la publiques.

En el siguiente comando sustituye `URL_DIRECTA_DE_HA_MCP` por esa URL.
`mcp set` reemplaza la entrada existente si se registró una dirección incorrecta:

```bash
docker exec openclaw openclaw mcp set homeassistant \
  '{"url":"URL_DIRECTA_DE_HA_MCP","transport":"streamable-http","enabled":true}'
docker exec openclaw openclaw mcp doctor homeassistant --probe
```

No añadas un bearer token al usar la URL secreta estándar de HA-MCP.
La integración oficial de Home Assistant **Model Context Protocol Server** es
distinta: usa `/api/mcp` y autenticación en cabecera; no mezcles ambas configuraciones.

Referencias: [HA-MCP add-on](https://github.com/homeassistant-ai/ha-mcp/blob/master/homeassistant-addon/DOCS.md)
y [componente personalizado](https://github.com/homeassistant-ai/ha-mcp/blob/master/docs/in-process-server.md).

HA-MCP puede ofrecer herramientas de control y escritura. Registrar el servidor
no lo convierte en solo lectura. El agente `homelab-observer` conserva su lista
limitada a Proxmox, Grafana y `session_status`.

### Node-RED

```bash
docker exec openclaw openclaw mcp add nodered \
  --url http://IP_NODE_RED:8001/mcp \
  --transport streamable-http
docker exec openclaw openclaw mcp doctor nodered --probe
```

Consulta [las notas específicas](docs/apendice-b-nodered.md).

## 11. Portainer opcional

Portainer también monta el socket Docker y, por tanto, conserva privilegios
administrativos sobre el host. Despliega solo si lo necesitas y limita su acceso:

```bash
docker compose -f docker/portainer/docker-compose.yml up -d
```

## 12. Actualizar OpenClaw en Docker

En esta instalación, actualiza desde la consola del LXC mediante Docker Compose.
El botón de actualización web no es el procedimiento utilizado para sustituir
la imagen del contenedor. La actualización de `2026.9.2` a `2026.9.3` se ha
probado correctamente en el homelab, incluidas las comprobaciones de ambos MCP.

1. Haz una copia de seguridad o snapshot del LXC antes de actualizar.
2. Edita `config/secrets/runtime.env` y fija la versión deseada. Ejemplo probado:

```dotenv
OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.9.3
```

3. Desde la raíz del repositorio, elimina las variables exportadas que podrían
sobrescribir el archivo y descarga la imagen:

```bash
unset OPENCLAW_IMAGE OPENCLAW_GATEWAY_HOST

docker compose --env-file config/secrets/runtime.env \
  -f docker/openclaw/docker-compose.yml pull openclaw
```

4. Solo si la descarga termina correctamente, recrea OpenClaw:

```bash
docker compose --env-file config/secrets/runtime.env \
  -f docker/openclaw/docker-compose.yml up -d --force-recreate openclaw
```

5. Comprueba la versión y las conexiones:

```bash
docker exec openclaw openclaw --version
docker exec openclaw openclaw mcp doctor proxmox --probe
docker exec openclaw openclaw mcp doctor grafana --probe
```

La versión debe coincidir con la elegida y ambos MCP deben indicar `ok`.
Vuelve a abrir la interfaz web y prueba una consulta. Si falla el arranque,
consulta `docker logs --tail 100 openclaw`.

El volumen existente conserva configuración, credenciales e historial. No repitas
el onboarding ni elimines el volumen; no uses `docker compose down -v` para
actualizar. Este procedimiento recrea únicamente OpenClaw.

Para versiones posteriores, elige explícitamente una versión publicada y revisa
sus notas antes de repetir el proceso. Si una actualización migra los datos,
volver a una imagen anterior puede no ser suficiente: conserva la copia previa.

## Checklist

- [ ] LXC, Docker, `ia-net` y `mcp-net` operativos.
- [ ] Secretos reales únicamente en `config/secrets/runtime.env`.
- [ ] Token Proxmox dedicado, `privsep=1` y `PVEAuditor` efectivo.
- [ ] Service account Grafana con rol `Viewer`.
- [ ] Proxmox MCP anuncia `risk=read`.
- [ ] Grafana MCP funciona con `--disable-write`.
- [ ] OpenClaw no tiene montado `/var/run/docker.sock`.
- [ ] Ambos `mcp doctor --probe` terminan correctamente.
- [ ] Automatización diaria probada manualmente antes de configurar entrega.

## Seguridad

- Los límites se aplican en el servidor MCP y en las credenciales, no solo en el
  prompt del agente.
- No conectes contenedores no confiables a `mcp-net`.
- No subas `runtime.env`, tokens, backups de OpenClaw ni salidas sin redactar.
- No eleves `PROXMOX_RISK_LEVEL`. Las acciones `lifecycle` o destructivas se
  incorporarán en un servicio independiente con aprobación externa.
- Trata el volumen `openclaw-config` como material sensible.


## Memoria y comprobaciones posteriores al despliegue

### Memoria textual sin una API adicional

Configuración comprobada en el homelab: la ruta es `memory.search.provider`,
no `agents.defaults.memorySearch`. Para buscar por palabras clave sin embeddings
de OpenAI:

```bash
docker exec openclaw openclaw config set --batch-json \
  '[{"path":"memory.search.provider","value":"none"}]'
docker restart openclaw
docker exec openclaw openclaw memory status --index --agent main
docker exec openclaw openclaw memory status --index --agent homelab-observer
```

Ejecuta el último comando después de crear el agente del punto 9.
La comprobación satisfactoria muestra todos los archivos indexados, `Dirty: no`
y `FTS: ready`. Con `provider: none`, `Vector store: disabled` y
`No embedding provider available (FTS-only mode)` describen el modo elegido:
no se está usando búsqueda por similitud semántica. No necesitas una clave
OpenAI para esta configuración.

### Política del observador

```bash
docker exec openclaw openclaw config get agents.entries.homelab-observer.tools
```

La lista `allow` debe contener exclusivamente `proxmox__*`, `grafana__*` y
`session_status`. Esta consulta verifica la configuración del agente;
`sandbox explain` muestra otra capa y no sustituye esta comprobación.
El informe manual se ha probado con éxito. La lista no concede herramientas de
memoria al observador aunque sus archivos estén indexados. Verificar la ejecución
programada y el catálogo efectivo de una ejecución sigue siendo una comprobación
separada.

### Aviso de cabecera Grafana

En la instalación probada, el aviso de `mcp doctor` sobre un valor sensible
apareció aunque el archivo guardaba la referencia a
`${GRAFANA_MCP_SERVER_TOKEN}` y la variable existía en el contenedor.
No sustituir esa referencia por el token literal ni publicar el archivo completo.
El aviso por sí solo no demuestra que el secreto se haya escrito en la configuración.

## Experimento Cloudflare Workers AI

Las pruebas directas con Qwen funcionan con contenido de texto, pero el agente
OpenClaw aún encuentra un rechazo HTTP 400 al continuar con herramientas.
Se ha añadido un [adaptador experimental y su guía de prueba](docs/cloudflare-adapter.md)
para normalizar mensajes assistant con content nulo y tool_calls, y conservar
los dígitos que Cloudflare entrega como números en el streaming. La guía incluye
cómo reconstruir el adaptador y comprobar las cifras tras actualizar.
Moonshot sigue siendo el proveedor principal; el adaptador se despliega por separado.

## Licencia

Uso personal / homelab. Adapta libremente.
