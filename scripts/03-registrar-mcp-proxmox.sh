#!/bin/bash
# Ejecutar DENTRO del LXC, con OpenClaw ya operativo.
# Uso: ./03-registrar-mcp-proxmox.sh <ip-nodo-proxmox> <token-secret> [usuario] [token-name]
set -euo pipefail

PROXMOX_HOST="${1:?Uso: $0 <ip-nodo-proxmox> <token-secret> [usuario] [token-name]}"
PROXMOX_TOKEN_VALUE="${2:?Falta el secret del token}"
PROXMOX_USER="${3:-mcp@pve}"
PROXMOX_TOKEN_NAME="${4:-mcp}"

echo ">> Probando conectividad con la API de Proxmox..."
curl -k -s "https://${PROXMOX_HOST}:8006/api2/json/version" \
  -H "Authorization: PVEAPIToken=${PROXMOX_USER}!${PROXMOX_TOKEN_NAME}=${PROXMOX_TOKEN_VALUE}" | grep -q version \
  && echo "OK: token válido" || { echo "ERROR: no se pudo autenticar contra Proxmox"; exit 1; }

echo ">> Probando el contenedor MCP manualmente (Ctrl+C tras unos segundos de silencio = éxito)..."
timeout 5 docker exec -it openclaw sh -c "docker run -i --rm \
  -e PROXMOX_HOST=${PROXMOX_HOST} \
  -e PROXMOX_USER=${PROXMOX_USER} \
  -e PROXMOX_TOKEN_NAME=${PROXMOX_TOKEN_NAME} \
  -e PROXMOX_TOKEN_VALUE=${PROXMOX_TOKEN_VALUE} \
  ghcr.io/akmalovaa/proxmox-mcp:latest" || true

echo ">> Registrando el MCP en OpenClaw..."
docker exec -it openclaw sh -c "
openclaw mcp add proxmox \
  --command=docker \
  --arg=run \
  --arg=-i \
  --arg=--rm \
  --arg=-e \
  --arg=PROXMOX_HOST=${PROXMOX_HOST} \
  --arg=-e \
  --arg=PROXMOX_USER=${PROXMOX_USER} \
  --arg=-e \
  --arg=PROXMOX_TOKEN_NAME=${PROXMOX_TOKEN_NAME} \
  --arg=-e \
  --arg=PROXMOX_TOKEN_VALUE=${PROXMOX_TOKEN_VALUE} \
  --arg=ghcr.io/akmalovaa/proxmox-mcp:latest
"

echo ">> Verificación final:"
docker exec -it openclaw sh -c "openclaw mcp doctor proxmox --probe"
