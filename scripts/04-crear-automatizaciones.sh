#!/usr/bin/env bash
# Crea automatizaciones seguras e idempotentes. No configura entrega externa.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ENV="${RUNTIME_ENV:-${REPO_ROOT}/config/secrets/runtime.env}"

if [ -f "$RUNTIME_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$RUNTIME_ENV"
  set +a
fi

AUTOMATION_TZ="${AUTOMATION_TZ:-Etc/UTC}"
JOB_NAME="homelab-health-daily"
AGENT_ID="homelab-observer"

if ! docker exec openclaw openclaw agents list --json | grep -q "$AGENT_ID"; then
  echo ">> Creando el agente restringido $AGENT_ID..."
  docker exec openclaw openclaw agents add "$AGENT_ID" \
    --workspace "/home/node/.openclaw/workspace-${AGENT_ID}" \
    --non-interactive
fi

# Allowlist absoluta: sin shell, filesystem, navegador, mensajería ni MCP ajenos.
docker exec openclaw openclaw config set --batch-json \
  "[{\"path\":\"agents.entries.${AGENT_ID}.tools\",\"value\":{\"allow\":[\"proxmox__*\",\"homeassistant__ha_get_logs\",\"session_status\"]}}]"

if docker exec openclaw openclaw automations list --all --json | grep -q "$JOB_NAME"; then
  echo ">> La automatización $JOB_NAME ya existe; se conserva su horario, mensaje y entrega."
  echo ">> Los permisos del observador se han ajustado a Proxmox y lectura de logs HA."
  exit 0
fi

docker exec openclaw openclaw automations create "0 8 * * *" \
  "Genera un informe de salud del homelab usando únicamente herramientas de lectura de Proxmox y los logs de Home Assistant. Resume nodos o cargas con problemas, almacenamiento por encima del 80 % y tareas recientes con error. Distingue cargas apagadas de fallos confirmados. Consulta ha_get_logs con source=system para errores y advertencias; usa source=error_log si necesitas ampliar el diagnóstico. Prioriza las últimas 24 horas según las fechas disponibles, agrupa mensajes repetidos e indica integración afectada, gravedad y última aparición. Explica los límites de cobertura y no presentes contadores acumulados como recuentos diarios. No consultes Grafana ni borres logs. Omite secretos del informe. No ejecutes cambios. Si faltan datos, indícalo explícitamente. Prioriza riesgos y termina con acciones recomendadas." \
  --name "$JOB_NAME" \
  --agent "$AGENT_ID" \
  --session isolated \
  --tz "$AUTOMATION_TZ" \
  --timeout-seconds 300 \
  --no-deliver

echo ">> Creada $JOB_NAME a las 08:00 ($AUTOMATION_TZ), sin entrega externa."
echo ">> Obtén su ID con: docker exec openclaw openclaw automations list --all"
echo ">> Prueba: docker exec openclaw openclaw automations run <job-id> --wait"
