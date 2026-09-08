#!/usr/bin/env bash
# Registra en OpenClaw los MCP HTTP desplegados por docker/mcp/docker-compose.yml.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ENV="${RUNTIME_ENV:-${REPO_ROOT}/config/secrets/runtime.env}"
CURL_IMAGE="curlimages/curl:8.18.0@sha256:d94d07ba9e7d6de898b6d96c1a072f6f8266c687af78a74f380087a0addf5d17"

if [ ! -f "$RUNTIME_ENV" ]; then
  echo "Falta $RUNTIME_ENV. Cópialo desde runtime.env.example y rellena los secretos."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$RUNTIME_ENV"
set +a

: "${GRAFANA_MCP_SERVER_TOKEN:?Falta GRAFANA_MCP_SERVER_TOKEN en runtime.env}"

echo ">> Comprobando endpoints MCP dentro de mcp-net..."
docker run --rm --network mcp-net "$CURL_IMAGE" -fsS \
  http://proxmox-mcp:8000/readyz >/dev/null
docker run --rm --network mcp-net "$CURL_IMAGE" -fsS \
  -H "Authorization: Bearer ${GRAFANA_MCP_SERVER_TOKEN}" \
  http://grafana-mcp:8000/healthz >/dev/null

echo ">> Registrando Proxmox MCP (solo lectura)..."
docker exec openclaw openclaw mcp set proxmox \
  '{"url":"http://proxmox-mcp:8000/mcp","transport":"streamable-http","enabled":true}'

echo ">> Registrando Grafana MCP (solo lectura)..."
docker exec openclaw openclaw mcp set grafana \
  '{"url":"http://grafana-mcp:8000/mcp","transport":"streamable-http","enabled":true,"headers":{"Authorization":"Bearer ${GRAFANA_MCP_SERVER_TOKEN}"}}'

echo ">> Verificando catálogo y conexión..."
docker exec openclaw openclaw mcp doctor proxmox --probe
docker exec openclaw openclaw mcp doctor grafana --probe

echo ">> MCP registrados. OpenClaw no necesita acceso al socket Docker."
