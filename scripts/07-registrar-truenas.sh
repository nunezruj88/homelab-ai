#!/usr/bin/env bash
# Ejecutar después de desplegar y probar docker/truenas-mcp.
set -euo pipefail
docker exec openclaw openclaw mcp set truenas \
  '{"url":"http://truenas-mcp:8000/mcp","transport":"streamable-http","enabled":true}'
docker exec openclaw openclaw mcp doctor truenas --probe
echo ">> TrueNAS registrado. Actualiza permisos y mensaje según docs/truenas-mcp.md."
