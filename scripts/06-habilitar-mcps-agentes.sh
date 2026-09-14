#!/usr/bin/env bash
# Añade los MCP existentes a todos los agentes sin cambiar modelos ni credenciales.
set -euo pipefail

docker exec openclaw openclaw mcp doctor proxmox --probe
docker exec openclaw openclaw mcp doctor homeassistant --probe

docker exec -i openclaw node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';

function cli(args) {
  return execFileSync('openclaw', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}
const agents = JSON.parse(cli(['agents', 'list', '--json']));
const config = JSON.parse(cli(['config', 'get', 'agents.entries']));
if (!Array.isArray(agents) || !agents.length ||
    !config || typeof config !== 'object' || Array.isArray(config)) {
  throw new Error('Formato de agentes inesperado; no se ha modificado la configuración.');
}
const updates = agents.map(agent => {
  const id = agent.id;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('ID de agente inesperado; no se ha modificado la configuración.');
  }
  const tools = structuredClone(config[id]?.tools ?? {});
  if (id === 'homelab-observer') {
    // Conserva el contrato de solo lectura de la automatización diaria.
    tools.allow = ['proxmox__*', 'homeassistant__ha_get_logs', 'session_status'];
    delete tools.alsoAllow;
  } else {
    const field = Array.isArray(tools.allow) ? 'allow' : 'alsoAllow';
    const existing = tools[field] ?? [];
    if (!Array.isArray(existing) || existing.some(x => typeof x !== 'string')) {
      throw new Error('Lista de herramientas inválida para ' + id);
    }
    tools[field] = [...new Set([
      ...existing.filter(x => !x.startsWith('grafana__')),
      'proxmox__*', 'homeassistant__*'
    ])];
  }
  return { path: 'agents.entries.' + id + '.tools', value: tools };
});
process.stdout.write(cli(['config', 'set', '--batch-json', JSON.stringify(updates)]));
for (const update of updates) {
  console.log('Actualizado: ' + update.path);
}
NODE

echo ">> Permisos añadidos. Las políticas deny, globales y del sandbox siguen vigentes."
echo ">> Abre una sesión nueva y comprueba una consulta de lectura en cada agente."
