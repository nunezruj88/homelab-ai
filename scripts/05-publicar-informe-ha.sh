#!/usr/bin/env bash
# Lee informes existentes; no ejecuta el agente ni modifica la automatización.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_ENV_FILE="${REPORT_ENV_FILE:-/etc/homelab-report.env}"
if [ ! -r "$REPORT_ENV_FILE" ]; then
  echo "Falta $REPORT_ENV_FILE" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$REPORT_ENV_FILE"
set +a
exec 9>/run/lock/homelab-report-publisher.lock
flock -n 9 || exit 0
docker exec -i \
  -e HOMELAB_PUBLISH_RUN=1 \
  -e HOMELAB_REPORT_TOKEN \
  -e HOMELAB_REPORT_URL \
  -e HOMELAB_REPORT_JOB_ID \
  openclaw node --input-type=module < "$REPO_ROOT/integrations/homeassistant/report-publisher.mjs"
