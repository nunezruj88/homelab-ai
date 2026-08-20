#!/bin/bash
# Ejecutar DENTRO del LXC, después de "docker compose up -d" en docker/openclaw/.
# Completa el onboarding de OpenClaw, que no se hace solo la primera vez.
set -euo pipefail

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  echo "Exporta OPENCLAW_GATEWAY_TOKEN antes de ejecutar este script, o pásalo como argumento:"
  echo "  OPENCLAW_GATEWAY_TOKEN=xxxx ./02-onboard-openclaw.sh"
  exit 1
fi

VOLUME=$(docker volume ls --format '{{.Name}}' | grep openclaw-config | head -1)
if [ -z "$VOLUME" ]; then
  echo "No se encontró el volumen de configuración de OpenClaw. ¿Se desplegó el stack?"
  exit 1
fi
echo ">> Usando volumen: $VOLUME"

echo ">> Parando el contenedor (puede estar en bucle de reinicio, es normal)..."
docker stop openclaw || true

echo ">> Ejecutando onboarding interactivo..."
docker run --rm -it \
  -v "${VOLUME}:/home/node/.openclaw" \
  --network ia-net \
  -e "OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}" \
  --entrypoint node \
  openclaw-custom:latest \
  dist/index.js onboard --mode local --no-install-daemon

echo ">> Fijando modo y bind explícitamente..."
docker run --rm \
  -v "${VOLUME}:/home/node/.openclaw" \
  --entrypoint node \
  openclaw-custom:latest \
  dist/index.js config set --batch-json '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"}]'

echo ">> Arrancando el servicio..."
docker start openclaw

sleep 3
echo ">> Verificación:"
curl -fsS http://localhost:18789/healthz && echo
curl -fsS http://localhost:18789/readyz && echo

echo ">> Onboarding completado. Configura el modelo con: docker exec -it openclaw openclaw configure"
