# Retirar Grafana MCP de todos los agentes

La instalación de esta guía registra Grafana en `mcp.servers.grafana`, compartido
por todos los agentes. Eliminar ese registro y reiniciar el gateway retira sus
herramientas del catálogo de todos ellos, incluidos main, cloudflare-test,
nvidia, openai y homelab-observer.

## Aplicar en el LXC

Desde la consola de homelabia:

```bash
cd /root/homelab-ai
git pull --ff-only
docker exec openclaw openclaw mcp unset grafana
docker restart openclaw
docker exec openclaw openclaw mcp list
```

Si `unset` indica que no existe, comprueba con `mcp list` que Grafana ya esté
ausente. Si aparece otro error, resuélvelo antes de continuar.

Retira el contenedor del servidor MCP:

```bash
docker stop grafana-mcp
docker rm grafana-mcp
```

Si Docker indica que el contenedor no existe, ya está retirado. Estos comandos
solo afectan a `grafana-mcp`; la aplicación Grafana y sus dashboards se conservan.

## Limpiar el entorno del contenedor

El Compose actualizado ya no inyecta el token de Grafana. Para aplicar también
ese cambio, recrea OpenClaw usando la misma imagen que está ejecutándose:

```bash
OPENCLAW_IMAGE="$(docker inspect openclaw --format '{{.Config.Image}}')" \
docker compose --env-file config/secrets/runtime.env \
  -f docker/openclaw/docker-compose.yml up -d --force-recreate openclaw
```

Comprueba antes que `OPENCLAW_GATEWAY_HOST` en runtime.env sigue siendo la IP
que utilizas para entrar en la web. El volumen conserva agentes, claves e
historial. Elimina de runtime.env las entradas `GRAFANA_URL`,
`GRAFANA_SERVICE_ACCOUNT_TOKEN` y `GRAFANA_MCP_SERVER_TOKEN` que ya no se usan.

## Verificación

```bash
docker exec openclaw openclaw mcp list
docker exec openclaw openclaw mcp doctor proxmox --probe
docker exec openclaw openclaw mcp doctor homeassistant --probe
```

La lista no debe incluir Grafana. La última prueba corresponde a instalaciones
que ya tienen Home Assistant registrado. Abre una sesión nueva en la web para
probar los agentes con el catálogo actualizado.

Si una allowlist antigua conserva `grafana__*`, esa entrada no concede ninguna
herramienta tras quitar el servidor. Puede retirarse al editar esa lista,
conservando los demás permisos y sin borrar toda la política de herramientas.
El script 04 actualiza la lista del observador a Proxmox, lectura de logs HA y
session_status; si el informe ya existe, conserva su horario, mensaje y entrega.
Los ejemplos de nuevos agentes y el script 03 ya no añaden Grafana.

Referencia: [registro MCP de OpenClaw](https://docs.openclaw.ai/cli/mcp/registry).
