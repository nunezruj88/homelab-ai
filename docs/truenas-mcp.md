# TrueNAS en el informe diario

Integración opcional para TrueNAS 25.10 mediante su API WebSocket. Publica una única
herramienta de lectura, `truenas__get_health`: pools, capacidad y clases de alertas.
No ejecuta cambios ni consulta SMART, snapshots, scrub o replicaciones directamente.
Las alertas no incluyen texto libre ni argumentos para evitar trasladar secretos.
Un fallo de consulta se marca como dato desconocido, no como ausencia de incidencias.

## 1. Preparar credenciales

Utiliza una API key dedicada con permisos de solo lectura. En esta instalación
TrueNAS está en `10.8.1.16` y la clave ya comprobada está en
`/etc/homelab-truenas.key`. No pegues la clave en el repositorio.

En el LXC de OpenClaw:

```bash
cd /root/homelab-ai
git pull --ff-only
install -d -o 10001 -g 10001 -m 700 /etc/homelab-truenas-mcp
install -o 10001 -g 10001 -m 400 /etc/homelab-truenas.key /etc/homelab-truenas-mcp/api.key
```

Crea `/etc/homelab-truenas.env` con estos valores (conserva los ajustes si ya existe):

```dotenv
TRUENAS_URL=wss://10.8.1.16/api/current
TRUENAS_VERIFY_SSL=true
TRUENAS_SECRET_DIR=/etc/homelab-truenas-mcp
```

Usa siempre WSS: TrueNAS puede revocar las claves utilizadas sin TLS.
Si usas una CA propia, copia su certificado de confianza como
`/etc/homelab-truenas-mcp/ca.pem`, legible por UID 10001. El certificado del servidor
debe cubrir la IP o el nombre utilizado. Para la prueba con certificado autofirmado
del homelab puedes establecer `TRUENAS_VERIFY_SSL=false`: mantiene el cifrado pero
no comprueba la identidad del servidor. No descargues y confíes automáticamente
en un certificado obtenido de una conexión no verificada.

## 2. Desplegar y comprobar

La red externa `mcp-net` debe existir. No se publica ningún puerto en el host
ni se monta el socket Docker. Solo este servicio recibe la clave de TrueNAS.

```bash
docker compose --env-file /etc/homelab-truenas.env \
  -f docker/truenas-mcp/docker-compose.yml up -d --build

docker exec truenas-mcp python -c 'import json; from server import get_health; print(json.dumps(get_health(), ensure_ascii=False, indent=2))'

bash scripts/07-registrar-truenas.sh
```

La consulta real debe mostrar `vault`, su estado y las métricas disponibles.
Revisa `query_errors`: una respuesta parcial no demuestra que todas las consultas
funcionen. `/healthz` solo verifica el proceso; MCP doctor verifica el protocolo.
La consulta usa una caché de 60 segundos y limita cada lista a 200 elementos,
indicando su total y si se truncó.

## 3. Actualizar el informe existente

Estos comandos conservan horario y entrega. El ID corresponde a la automatización
de este homelab; en otra instalación obtén el ID con `automations list --all`.

```bash
docker exec openclaw openclaw config set --batch-json \
  '[{"path":"agents.entries.homelab-observer.tools","value":{"allow":["proxmox__*","homeassistant__ha_get_logs","truenas__get_health","session_status"]}}]'

docker exec openclaw openclaw automations edit c2c20bac-2f48-4605-b64a-5f7dfd40c743 \
  --tools 'proxmox__*,homeassistant__ha_get_logs,truenas__get_health,session_status' \
  --message "$(cat config/automations/homelab-health-daily.txt)"

docker exec openclaw openclaw automations run c2c20bac-2f48-4605-b64a-5f7dfd40c743 --wait

bash scripts/05-publicar-informe-ha.sh
```

El informe completo tendrá tres secciones: Proxmox, Home Assistant y TrueNAS.
Los dos sensores de tablas existentes mantienen sus delimitadores y nombres.
No se crea un sensor adicional de TrueNAS. La tarjeta del informe completo
mostrará la nueva sección después de publicarlo.

Si tu tarjeta de Home Assistant extrae todo lo que sigue a su encabezado,
termina esa extracción antes de TrueNAS para evitar mezclar ambas secciones:

```jinja
{% set report = state_attr('sensor.homelab_informe', 'report') or '' %}
{{ report.split('## Home Assistant\n', 1)[1].split('\n## TrueNAS', 1)[0]
   if '## Home Assistant\n' in report else 'Esperando informe.' }}
```

## Referencias

- [Cliente oficial TrueNAS](https://github.com/truenas/api_client/tree/TS-25.10.3).
- [Pools en la API 25.10](https://api.truenas.com/v25.10/api_methods_pool.query.html).
- [Alertas en la API 25.10](https://api.truenas.com/v25.10/api_methods_alert.list.html).
