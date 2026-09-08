# Plano de control MCP

OpenClaw se conecta a los MCP por Streamable HTTP sobre la red Docker `mcp-net`.
Los puertos de los servidores MCP no se publican en el host y OpenClaw no monta
`/var/run/docker.sock`.

```text
OpenClaw ── mcp-net ── Proxmox MCP (risk=read) ── Proxmox API (PVEAuditor)
                    └─ Grafana MCP (--disable-write) ── Grafana API (Viewer)
```

## Fronteras de seguridad

- Proxmox registra solamente herramientas del nivel `read`.
- El token Proxmox pertenece a un usuario dedicado, tiene `privsep=1` y el rol
  `PVEAuditor` se concede también al token.
- Grafana MCP arranca con `--disable-write` y una service account `Viewer`.
- Grafana MCP exige un bearer token al cliente. OpenClaw guarda una referencia
  `${GRAFANA_MCP_SERVER_TOKEN}`, no el valor literal.
- `mcp-net` no publica puertos. No es una frontera de autenticación por sí sola:
  no conectes contenedores no confiables a esa red.
- No existe todavía un MCP privilegiado. Las operaciones de escritura requieren
  un diseño separado con credenciales, allowlist y aprobación externa.

## Despliegue

Desde la raíz del repositorio:

```bash
cp config/secrets/runtime.env.example config/secrets/runtime.env
nano config/secrets/runtime.env

docker network inspect ia-net >/dev/null 2>&1 || docker network create ia-net
docker network inspect mcp-net >/dev/null 2>&1 || docker network create mcp-net

docker compose --env-file config/secrets/runtime.env \
  -f docker/mcp/docker-compose.yml up -d
docker compose --env-file config/secrets/runtime.env \
  -f docker/openclaw/docker-compose.yml up -d

scripts/02-onboard-openclaw.sh
scripts/03-registrar-mcps.sh
```

Para acceder al gateway desde la LAN, cambia `OPENCLAW_GATEWAY_HOST` de
`127.0.0.1` a la IP del LXC. No uses `0.0.0.0` salvo que un firewall limite el
acceso.

## Automatización inicial

`scripts/04-crear-automatizaciones.sh` crea el agente `homelab-observer` con una
allowlist absoluta (`proxmox__*`, `grafana__*`, `session_status`) y programa un
informe diario en una sesión aislada. No tiene shell, filesystem, navegador,
mensajería ni acceso a otros MCP. Se instala inicialmente sin entrega externa.
Tras una ejecución manual satisfactoria, configura el canal de entrega desde la
UI de OpenClaw o con `openclaw automations edit`.

## Operación

```bash
docker compose --env-file config/secrets/runtime.env \
  -f docker/mcp/docker-compose.yml ps
docker exec openclaw openclaw mcp status --verbose
docker exec openclaw openclaw mcp doctor proxmox --probe
docker exec openclaw openclaw mcp doctor grafana --probe
docker exec openclaw openclaw automations list --all
```
