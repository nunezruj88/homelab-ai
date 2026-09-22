# Homelab IA

Stack de IA autoalojado sobre Proxmox. OpenClaw se organiza en dos agentes:
**Conchi** para las conversaciones y **homelab-observer** para el informe diario.
Ambos pueden utilizar Moonshot, Cloudflare, NVIDIA y OpenAI; sus permisos de
herramientas son distintos. Node-RED publica el informe en Home Assistant.

```text
OpenClaw ── MCP HTTP ────┬─ Proxmox MCP (solo lectura) ── Proxmox API
                         ├─ Home Assistant MCP
                         └─ TrueNAS MCP (solo lectura, opcional)
```

OpenClaw no tiene acceso al socket Docker. Proxmox MCP funciona como servicio
independiente con transporte Streamable HTTP, herramientas `read` y un token
`PVEAuditor`. Consulta [el diseño del plano de control](docs/arquitectura-mcp.md).

> Moonshot sigue siendo el proveedor principal. Cloudflare funciona con un
> adaptador dedicado, incluido el intercambio MCP y las cifras de las respuestas.
> La prueba histórica con LiteLLM se conserva en
> [el apéndice de Cloudflare](docs/apendice-a-cloudflare.md).

## Estructura

```text
homelab-ai/
├── config/
│   ├── mcp/catalog.yaml             # inventario y política de los MCP
│   └── secrets/runtime.env.example  # plantilla única; runtime.env no se versiona
├── docker/
│   ├── mcp/docker-compose.yml       # Proxmox MCP
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

Prueba primero un saludo y después consultas de lectura a Proxmox.
Si aparece un aviso de memoria por falta de clave OpenAI, diagnostícalo por
separado: la clave Moonshot no configura el proveedor de embeddings.

La arquitectura MCP no depende del proveedor. El modelo se puede sustituir sin
cambiar los servidores ni sus credenciales.

## 8. Registrar y verificar MCP

```bash
scripts/03-registrar-mcps.sh
```

El script comprueba la salud de Proxmox MCP, registra su URL interna y ejecuta
`mcp doctor --probe`. Home Assistant se registra por separado en el punto 10.

## 9. Instalar la automatización inicial

Para incluir los logs, registra primero Home Assistant siguiendo el punto 10.
El informe consulta Proxmox y logs de Home Assistant. Si la tarea ya existe,
el script conserva su mensaje, horario y entrega, y actualiza los permisos del observador.

```bash
scripts/04-crear-automatizaciones.sh
```

Crea `homelab-health-daily` a las 08:00 de `AUTOMATION_TZ`. Se ejecuta en una
sesión aislada mediante el agente `homelab-observer`. Su allowlist contiene
únicamente `proxmox__*`, `homeassistant__ha_get_logs`, `truenas__get_health` y `session_status`: no dispone de shell,
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
limitada a Proxmox, `homeassistant__ha_get_logs`, `truenas__get_health` y `session_status`.

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
probado correctamente en el homelab, incluidas las comprobaciones de MCP.

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
```

La versión debe coincidir con la elegida y Proxmox MCP debe indicar `ok`.
Vuelve a abrir la interfaz web y prueba una consulta. Si falla el arranque,
consulta `docker logs --tail 100 openclaw`.

El volumen existente conserva configuración, credenciales e historial. No repitas
el onboarding ni elimines el volumen; no uses `docker compose down -v` para
actualizar. Este procedimiento recrea únicamente OpenClaw.

Para versiones posteriores, elige explícitamente una versión publicada y revisa
sus notas antes de repetir el proceso. Si una actualización migra los datos,
volver a una imagen anterior puede no ser suficiente: conserva la copia previa.

## 13. Agentes: Conchi y homelab-observer

La organización del homelab utiliza dos agentes. Los proveedores y modelos se
seleccionan dentro de cada agente; no se crea un agente por proveedor.

| Nombre | ID | Función | Herramientas permitidas |
| --- | --- | --- | --- |
| Conchi | `conchi` | Conversaciones y consultas del homelab | `proxmox__*`, `homeassistant__*`, `truenas__get_health`, `session_status` |
| homelab-observer | `homelab-observer` | Informe diario y automatización de salud | `proxmox__*`, `homeassistant__ha_get_logs`, `truenas__get_health`, `session_status` |

Proxmox y TrueNAS mantienen sus servidores de solo lectura.
`homeassistant__*` permite a Conchi las herramientas de control que ofrezca HA-MCP;
el observador solo consulta sus logs. Compartir proveedores no amplía permisos.
TrueNAS es opcional y se despliega según el punto 16.

### Crear Conchi

Comprueba primero `docker exec openclaw openclaw agents list --json`.
Ejecuta el alta únicamente si `conchi` todavía no existe:

```bash
docker exec openclaw openclaw agents add conchi \
  --workspace /home/node/.openclaw/workspace-conchi \
  --model moonshot/kimi-k2.6 \
  --non-interactive

docker exec openclaw openclaw agents set-identity \
  --agent conchi --name "Conchi"

docker exec openclaw openclaw config set --batch-json \
  '[{"path":"agents.entries.conchi.tools","value":{"allow":["proxmox__*","homeassistant__*","truenas__get_health","session_status"]}}]'
```

El script 04 crea el observador si falta y conserva la automatización existente.
En instalaciones nuevas, el onboarding puede crear un agente inicial: no lo
retires hasta verificar las credenciales y dependencias de los dos agentes.
Esta documentación describe la organización deseada; actualizar el repositorio
no elimina agentes ni migra bases de datos del LXC.

### Modelos compartidos

Estas son las referencias registradas en el homelab; conserva los identificadores
que ya funcionan en tu configuración:

| Proveedor | Referencia del modelo | Alias |
| --- | --- | --- |
| Moonshot | `moonshot/kimi-k2.6` | Kimi K2.6 |
| Cloudflare | `cloudflare-test/@cf/qwen/qwen3-30b-a3b-fp8` | Cloudflare Qwen |
| NVIDIA | `nvidia/nemotron-3.5-lightning-30b-a3b` | NVIDIA Lightning |
| OpenAI | `openai/gpt-5.6-luna` | GPT-5.6 Luna |

`cloudflare-test` sigue siendo el ID del proveedor, no un agente que haya que
crear. Cloudflare utiliza el [adaptador](docs/cloudflare-adapter.md).
Los identificadores y disponibilidad dependen del proveedor y de la cuenta:
no reconstruyas un proveedor que ya funciona a partir del nombre comercial.
Otros alias históricos en el catálogo no implican disponibilidad confirmada.

El catálogo compartido está en `agents.defaults.models`. Para añadir un alias
sin reemplazar los existentes:

```bash
docker exec openclaw openclaw config set agents.defaults.models \
  '{"moonshot/kimi-k2.6":{"alias":"Kimi K2.6"}}' --strict-json --merge
```

Moonshot es el modelo inicial. Para cambiar el modelo principal de Conchi:

```bash
docker exec openclaw openclaw config set --batch-json \
  '[{"path":"agents.entries.conchi.model","value":"nvidia/nemotron-3.5-lightning-30b-a3b"}]'
```

En la web selecciona explícitamente Conchi o el observador y después el modelo.
Cambiar el modelo de una conversación no debe darse por equivalente a cambiar
el modelo de la automatización diaria.

### Credenciales y verificación

Un alias visible no demuestra acceso a su clave. Ambos agentes necesitan un
perfil efectivo para cada proveedor. En el homelab se registraron NVIDIA y
OpenAI en ambos agentes y se comprobó su respuesta desde la web:

```bash
docker exec -it openclaw openclaw models auth paste-api-key --agent conchi --provider nvidia
docker exec -it openclaw openclaw models auth paste-api-key --agent conchi --provider openai
docker exec -it openclaw openclaw models auth paste-api-key --agent homelab-observer --provider nvidia
docker exec -it openclaw openclaw models auth paste-api-key --agent homelab-observer --provider openai
```

Usa estos comandos solo para configurar o renovar una clave; introdúcela cuando
se solicite, nunca como argumento ni en el repositorio. Para Moonshot o Cloudflare,
comprueba primero los perfiles efectivos antes de añadir credenciales duplicadas.

```bash
docker exec openclaw openclaw models status --agent conchi --json
docker exec openclaw openclaw models status --agent homelab-observer --json
```

En OpenClaw 2026.9.4, `models status --probe` se bloqueó con el Gateway activo.
El estado sin probe permite revisar la configuración; prueba la respuesta real
en una conversación nueva de cada agente y proveedor. Después prueba una consulta
MCP de lectura: un saludo no verifica las herramientas.

### Automatización y mantenimiento

`homelab-health-daily` conserva el agente `homelab-observer`, su horario y entrega.
No hay que recrear el informe para utilizar Conchi.
Antes de retirar agentes antiguos, revisa también las tareas con propietario
implícito, como la promoción de memoria, y asigna su destino explícitamente si
la versión permite editar esa tarea.

Los heartbeats administrados por OpenClaw no admiten `automations edit --disable`:
se desactivan en la configuración de su propietario con `heartbeat.every: "0m"`.
Las revisiones automáticas de skills también pueden depender de configuración
administrada por el sistema. No amplíes permisos de archivos o shell para
silenciar sus errores; diagnostica su configuración de origen.

El script `scripts/06-habilitar-mcps-agentes.sh` descubre los agentes existentes.
Añade Proxmox y Home Assistant a Conchi conservando los demás permisos, y mantiene
la allowlist restringida del observador, incluida la consulta de TrueNAS.
No crea agentes ni elimina los antiguos.

Referencias: [gestión de agentes](https://docs.openclaw.ai/cli/agents),
[modelos](https://docs.openclaw.ai/gateway/config-agents/models)
y [heartbeat](https://docs.openclaw.ai/heartbeat).

## 14. Dashboard del informe en Home Assistant

La [guía del dashboard](docs/dashboard-homeassistant.md) incluye un flujo importable
para Node-RED en `10.8.1.28`, un panel YAML y un publicador que consulta el último
informe existente cada hora. Reutiliza la conexión de Node-RED a Home
Assistant y requiere Node-RED Companion para crear el sensor.

La publicación completa mediante `chat.history` quedó comprobada en el homelab
el 22 de septiembre de 2026. Esta lectura sustituye la exportación de diagnóstico,
que podía devolver `[Malformed diagnostic JSON redacted]` aunque el informe se
viera bien en la web. El publicador rechaza marcadores y respuestas truncadas.

La generación diaria y la publicación son independientes: hay que instalar y
activar `homelab-report-publisher.timer` en el LXC. Cada hora vuelve a enviar el
último informe, aunque ya se haya publicado; conserva su fecha y no vuelve a
llamar al modelo. Para enviarlo inmediatamente:

```bash
cd /root/homelab-ai
bash scripts/05-publicar-informe-ha.sh
```

La guía incluye la instalación del servicio, el cambio de cinco minutos a una
hora y la comprobación del temporizador.

Si el informe se genera pero deja de publicarse y `systemctl list-timers --all
homelab-report-publisher.timer` muestra `NEXT -`, sigue la
[recuperación del temporizador](docs/dashboard-homeassistant.md#el-temporizador-aparece-con-next-vacío-y-no-publica).
La solución comprobada añade `OnActiveSec=1min` para iniciar la publicación y
mantiene `OnUnitActiveSec=1h`. La guía incluye el envío inmediato y la verificación
del registro. `inactive (dead)` en el servicio, por sí solo, no significa un fallo.

Muestra el informe de Proxmox y logs de Home Assistant, su fecha y avisos de
antigüedad o de ejecución fallida. Conserva la entrega en la web de OpenClaw y no
realiza llamadas adicionales al modelo. El despliegue es opcional y debe probarse
manualmente antes de activar el temporizador. No requiere volver a ejecutar el
script 04 ni modificar la base de datos de OpenClaw.

### Estado general y tarjetas rápidas

La [guía de Estado general](docs/estado-general.md) añade cuatro sensores de estado
para Proxmox, Home Assistant, TrueNAS y el conjunto del homelab. El publicador
aplica reglas fijas sobre datos estructurados transcritos por el modelo; no es
una comprobación independiente de las API. Las tarjetas muestran motivo,
cobertura, fecha y vigencia. A las 30 horas el estado pasa a unknown.
Incluye la actualización del mensaje del informe y las plantillas de Home
Assistant; no requiere cambiar el flujo de Node-RED.

## 15. Retirar Grafana MCP de instalaciones existentes

Grafana MCP ya no se despliega ni se registra con estos scripts. Para quitarlo
de todos los agentes de una instalación anterior, sigue la
[guía de retirada](docs/retirar-grafana-mcp.md). Actualizar el repositorio por sí solo
no elimina el registro guardado en OpenClaw.

## 16. TrueNAS en el informe (opcional)

La [guía de TrueNAS](docs/truenas-mcp.md) permite añadir pools, capacidad y alertas
al informe mediante un MCP de solo lectura. Incluye el despliegue en Docker,
credenciales separadas y la actualización de la automatización existente.
El informe incorpora una tercera sección principal, `## TrueNAS`.
Si el servicio no está instalado, el informe indicará que no se pudo evaluar.

## Checklist

- [ ] LXC, Docker, `ia-net` y `mcp-net` operativos.
- [ ] Secretos reales fuera del repositorio: `runtime.env` y archivos dedicados por servicio.
- [ ] Token Proxmox dedicado, `privsep=1` y `PVEAuditor` efectivo.
- [ ] Proxmox MCP anuncia `risk=read`.
- [ ] OpenClaw no tiene montado `/var/run/docker.sock`.
- [ ] `mcp doctor proxmox --probe` termina correctamente.
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
docker exec openclaw openclaw memory status --index --agent conchi
docker exec openclaw openclaw memory status --index --agent homelab-observer
```

Ejecuta las comprobaciones después de crear Conchi (punto 13) y el observador (punto 9).
La comprobación satisfactoria muestra todos los archivos indexados, `Dirty: no`
y `FTS: ready`. Con `provider: none`, `Vector store: disabled` y
`No embedding provider available (FTS-only mode)` describen el modo elegido:
no se está usando búsqueda por similitud semántica. No necesitas una clave
OpenAI para esta configuración.

### Política del observador

```bash
docker exec openclaw openclaw config get agents.entries.homelab-observer.tools
```

La lista `allow` debe contener exclusivamente `proxmox__*`, `homeassistant__ha_get_logs`,
`truenas__get_health` (integración opcional) y `session_status`. Esta consulta verifica la configuración del agente;
`sandbox explain` muestra otra capa y no sustituye esta comprobación.
El informe manual se ha probado con éxito. La lista no concede herramientas de
memoria al observador aunque sus archivos estén indexados. Verificar la ejecución
programada y el catálogo efectivo de una ejecución sigue siendo una comprobación
separada.

## Experimento Cloudflare Workers AI

La prueba real con Qwen en OpenClaw ya completó consultas a Proxmox MCP y
conservó las cifras tras desplegar el adaptador.
Se ha añadido un [adaptador experimental y su guía de prueba](docs/cloudflare-adapter.md)
para normalizar mensajes assistant con content nulo y tool_calls, y conservar
los dígitos que Cloudflare entrega como números en el streaming. La guía incluye
cómo reconstruir el adaptador y comprobar las cifras tras actualizar.
Moonshot sigue siendo el proveedor principal; el adaptador se despliega por separado.

## Licencia

Uso personal / homelab. Adapta libremente.
