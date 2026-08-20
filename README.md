# Homelab IA

Stack de IA agentic autoalojado sobre Proxmox: **OpenClaw (orquestador con MCP) → Kimi (Moonshot AI) → Proxmox MCP + Home Assistant MCP + Node-RED MCP**

```
        OpenClaw (orquestador)
         /              \
   Moonshot/Kimi      MCP Client
   (modelo)              /    |    \
                  Proxmox  Home    Node-RED
                    MCP  Assistant   MCP
                          MCP
```

> ℹ️ Cloudflare Workers AI + LiteLLM se probaron primero pero se aparcaron por un bug confirmado del lado de Cloudflare en tool-calling multi-turno. Ver [`docs/apendice-a-cloudflare.md`](docs/apendice-a-cloudflare.md). El stack final usa Kimi de forma nativa en OpenClaw, sin LiteLLM — más simple, sin ese bug, y con function calling fiable.

## Estructura del repo

```
homelab-ia/
├── README.md                        # esta guía
├── docker/
│   ├── openclaw/
│   │   ├── Dockerfile               # imagen OpenClaw + cliente Docker
│   │   ├── docker-compose.yml
│   │   └── .env.example
│   ├── litellm/                     # aparcado — ver docs/apendice-a-cloudflare.md
│   │   ├── config.yaml
│   │   ├── docker-compose.yml
│   │   └── .env.example
│   └── portainer/
│       └── docker-compose.yml
├── scripts/
│   ├── 01-crear-lxc.sh              # ejecutar en el HOST Proxmox
│   ├── 02-onboard-openclaw.sh       # ejecutar dentro del LXC
│   └── 03-registrar-mcp-proxmox.sh  # ejecutar dentro del LXC
└── docs/
    ├── apendice-a-cloudflare.md     # bug de Cloudflare Workers AI documentado
    └── apendice-b-nodered.md        # notas sobre node-red-contrib-mcp-server
```

## 0. Prerrequisitos

- [ ] Proxmox VE instalado y accesible (`https://<ip-proxmox>:8006`)
- [ ] Cuenta en [platform.moonshot.ai](https://platform.moonshot.ai) con API key generada
- [ ] IP fija reservada para el LXC (esta guía usa `10.8.1.101`)
- [ ] (Opcional) Node-RED ya desplegado en otro LXC/host
- [ ] (Opcional) Dominio propio + nginx si vas a exponer el gateway hacia fuera

Cada paso se despliega y se verifica **antes** de pasar al siguiente.

## 1. Crear el LXC

En el **host Proxmox**:

```bash
scripts/01-crear-lxc.sh
```

Revisa las variables al principio del script (`IP`, `GW`, `CORES`, `MEMORY`) antes de ejecutarlo.

**✅ Verificación** (ya dentro del LXC, `pct enter 200`):
```bash
ip a show eth0
ping -c 3 10.8.1.1
```

## 2. Instalar Docker (dentro del LXC)

```bash
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose-plugin
```

**✅ Verificación:**
```bash
docker --version && docker compose version && systemctl is-active docker
```

## 3. Desplegar Portainer

```bash
cd docker/portainer
docker compose up -d
docker logs portainer 2>&1 | grep -i token   # token de setup, caduca en 5 min
```

Accede a `https://10.8.1.101:9443` y crea el usuario admin.

## 4. Red Docker compartida

```bash
docker network create ia-net
```

Todos los `docker-compose.yml` de este repo ya referencian `ia-net` como red externa.

## 5. Construir la imagen de OpenClaw

Necesaria porque OpenClaw lanza el MCP de Proxmox como subproceso Docker — la imagen oficial no trae el cliente `docker`.

```bash
cd docker/openclaw
docker build -t openclaw-custom:latest .
```

**✅ Verificación:**
```bash
docker run --rm --entrypoint sh openclaw-custom:latest -c "docker --version"
```

## 6. Desplegar OpenClaw

```bash
cd docker/openclaw
cp .env.example .env
nano .env   # rellena OPENCLAW_GATEWAY_TOKEN (openssl rand -hex 32) y el GID real del docker.sock
docker compose up -d
```

⚠️ El `group_add` del compose usa el GID `991` por defecto — comprueba el tuyo con `ls -la /var/run/docker.sock` y ajústalo en `docker-compose.yml` si difiere.

Es normal que arranque en bucle de reinicio (`Missing config`) — falta el onboarding:

```bash
scripts/02-onboard-openclaw.sh
```

**✅ Verificación:**
```bash
curl -fsS http://localhost:18789/healthz   # {"ok":true,"status":"live"}
curl -fsS http://localhost:18789/readyz    # {"ready":true}
docker exec -it openclaw sh -c "docker ps" # debe listar contenedores del host
```

## 7. Configurar el modelo (Kimi / Moonshot)

```bash
docker exec -it openclaw openclaw configure
```
Elige **Gateway: Local**, proveedor **Moonshot**, y pega tu API key (confirma si es una "Moonshot API key" estándar y no una "Kimi Code API key" — son proveedores distintos).

```bash
docker exec -it openclaw sh -c "openclaw models set moonshot/kimi-k2.6"
docker exec -it openclaw sh -c "openclaw models status"   # debe mostrar api_key=1 en moonshot
```

## 8. MCP de Proxmox

Crea un token API de solo lectura en Proxmox (**Datacenter → Permissions**: usuario `mcp@pve`, token `mcp`, rol `PVEAuditor`), y:

```bash
scripts/03-registrar-mcp-proxmox.sh <ip-nodo-proxmox> <secret-del-token>
```

**✅ Verificación:**
```bash
docker exec -it openclaw sh -c "openclaw mcp doctor proxmox --probe"   # ok: true
```

## 9. MCP de Home Assistant

Si usas **HA-MCP** (community), coge la URL de "direct access" (no la de Nabu Casa si todo está en red local):

```bash
docker exec -it openclaw sh -c '
openclaw mcp add homeassistant \
  --url=http://<ip-home-assistant>:9584/private_XXXXXXXXXXXXXXXXX \
  --transport=streamable-http
'
docker exec -it openclaw sh -c "openclaw mcp doctor homeassistant --probe"
```

## 10. MCP de Node-RED

Ver [`docs/apendice-b-nodered.md`](docs/apendice-b-nodered.md) para la instalación del paquete y las trampas conocidas (nodo correcto a usar, endpoints reales). Resumen:

```bash
docker exec -it openclaw sh -c '
openclaw mcp add nodered \
  --url=http://<ip-nodered>:8001/mcp \
  --transport=streamable-http
'
docker exec -it openclaw sh -c "openclaw mcp doctor nodered --probe"
```

## 11. Prueba end-to-end

```bash
docker exec -it openclaw openclaw tui
```
```
/new
Lista los nodos de mi cluster Proxmox
Dime el estado de alguna entidad de mi Home Assistant
Usa la herramienta de Node-RED
```

También accesible en `http://10.8.1.101:18789` (pide el `OPENCLAW_GATEWAY_TOKEN`).

## 12. (Opcional) Exponer con dominio propio

Con nginx + certbot, reverse proxy de un subdominio hacia `10.8.1.101:18789`. No expongas el puerto directo a internet.

## Checklist resumen

- [ ] LXC con IP fija, Docker y Portainer operativos
- [ ] Red `ia-net` creada
- [ ] Imagen `openclaw-custom` construida
- [ ] OpenClaw Gateway arriba, sin bucle de reinicio
- [ ] Modelo Moonshot/Kimi configurado con auth resuelta
- [ ] MCP Proxmox, Home Assistant y Node-RED registrados y verificados
- [ ] Prueba end-to-end con las tres herramientas respondiendo datos reales

## Seguridad

- No subas nunca `.env` con secretos reales a este repo — usa `.env.example` como plantilla (ya cubierto por `.gitignore`).
- El MCP de Proxmox corre con el socket de Docker montado en OpenClaw (necesario para spawnear el contenedor stdio) — equivale a acceso root sobre el host. Asumible en homelab personal, revisar si se expone más allá de la red local.
- Rota cualquier token/API key que hayas pegado alguna vez en una terminal compartida o capturas de pantalla.

## Licencia

Uso personal / homelab. Adapta libremente.
