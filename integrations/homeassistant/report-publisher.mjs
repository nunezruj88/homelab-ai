import { execFileSync } from 'node:child_process';

export function selectReportRun(history, jobId) {
  const entries = Array.isArray(history) ? history : history?.entries;
  if (!Array.isArray(entries)) throw Error('Formato de historial no reconocido');
  const timestamp = e => Number(e.ts ?? e.runAtMs);
  const rows = entries.filter(e => e && (!e.jobId || e.jobId === jobId)
    && ['ok', 'error', 'skipped'].includes(e.status)
    && Number.isFinite(timestamp(e)) && timestamp(e) > 0)
    .sort((a, b) => timestamp(b) - timestamp(a));
  const good = rows.find(e => e.status === 'ok');
  if (!good) throw Error('No hay ejecución correcta en las últimas 20 entradas');
  return { good, latestStatus: rows[0].status };
}


const HEALTH_SYSTEMS = ['proxmox', 'homeassistant', 'truenas'];
const HEALTH_CHECKS = {
  proxmox: {nodes_offline:'count', backup_failures:'count', storage_max_percent:'percent', cpu_max_percent:'percent', ram_max_percent:'percent'},
  homeassistant: {unavailable:'bool', errors:'count', warnings:'count'},
  truenas: {pools_unhealthy:'count', pools_not_online:'count', pool_max_percent:'percent', active_critical_alerts:'count', active_warning_alerts:'count'},
};
const HEALTH_LABELS = {proxmox:'Proxmox', homeassistant:'Home Assistant', truenas:'TrueNAS', homelab:'Homelab'};
const HEALTH_START = '<!-- HOMELAB_STATUS_V1\n';
const HEALTH_END = '\nEND_HOMELAB_STATUS -->';

function healthResult(state, reasons, complete, source) {
  return {state, reason:reasons.join('; '), coverage:complete ? 'complete' : 'partial',
    source:source || 'No disponible', provenance:'model_transcribed',
    recommendation:state === 'ok' ? 'Mantener la supervisión.' :
      state === 'unknown' ? 'Completar las consultas y generar un informe nuevo.' :
      'Revisar las incidencias y contrastarlas con la interfaz del sistema.'};
}

export function evaluateHealth(evidence) {
  const result = {};
  for (const system of HEALTH_SYSTEMS) {
    const row = evidence?.schema === 1 ? evidence?.[system] : null;
    const values = {};
    for (const [key, type] of Object.entries(HEALTH_CHECKS[system])) {
      const v = row?.checks?.[key];
      values[key] = type === 'bool' ? (typeof v === 'boolean' ? v : null) :
        (typeof v === 'number' && Number.isFinite(v) && v >= 0 &&
          (type === 'percent' ? v <= 100 : Number.isSafeInteger(v)) ? v : null);
    }
    const source = typeof row?.source === 'string' ? row.source.slice(0, 300) : '';
    const complete = row?.coverage === 'complete' && source.trim().length > 0
      && Object.values(values).every(v => v !== null);
    const critical = [], warning = [];
    if (system === 'proxmox') {
      if (values.nodes_offline > 0) critical.push('Nodos offline: ' + values.nodes_offline);
      if (values.backup_failures > 0) warning.push('Tareas de backup fallidas: ' + values.backup_failures);
      for (const [key, label, threshold] of [['storage_max_percent','Almacenamiento',80],
        ['cpu_max_percent','CPU',90],['ram_max_percent','RAM',90]])
        if (values[key] > threshold) warning.push(label + ': ' + values[key] + '%');
    }
    if (system === 'homeassistant') {
      if (values.unavailable === true) critical.push('Indisponibilidad confirmada de Home Assistant');
      if (values.errors > 0) warning.push('Errores en la cobertura consultada: ' + values.errors);
      if (values.warnings > 0) warning.push('Warnings en la cobertura consultada: ' + values.warnings);
    }
    if (system === 'truenas') {
      if (values.pools_unhealthy > 0) critical.push('Pools no saludables: ' + values.pools_unhealthy);
      if (values.pools_not_online > 0) critical.push('Pools no ONLINE: ' + values.pools_not_online);
      if (values.active_critical_alerts > 0) critical.push('Alertas críticas no descartadas: ' + values.active_critical_alerts);
      if (values.active_warning_alerts > 0) warning.push('Alertas no críticas de advertencia: ' + values.active_warning_alerts);
      if (values.pool_max_percent > 80) warning.push('Uso máximo de pool: ' + values.pool_max_percent + '%');
    }
    const state = critical.length ? 'critical' : warning.length ? 'warning' : complete ? 'ok' : 'unknown';
    const reasons = [...critical, ...warning];
    if (!complete) reasons.push('Cobertura incompleta o datos no válidos');
    if (!reasons.length) reasons.push('Sin incidencias en las comprobaciones declaradas');
    result[system] = healthResult(state, reasons, complete, source);
  }
  const rows = Object.values(result);
  const state = rows.some(r => r.state === 'critical') ? 'critical' :
    rows.some(r => r.state === 'warning') ? 'warning' :
    rows.every(r => r.state === 'ok') ? 'ok' : 'unknown';
  result.homelab = healthResult(state, HEALTH_SYSTEMS.map(s => HEALTH_LABELS[s] + ': ' + result[s].state),
    rows.every(r => r.coverage === 'complete'), 'Proxmox, Home Assistant y TrueNAS');
  return result;
}


export function assertUsableReport(text) {
  if (/\[(?:Malformed|Oversized) diagnostic JSON redacted\]/i.test(text))
    throw Error('El historial de OpenClaw contiene un marcador de redacción; no se publica ni se reemplaza el sensor. Revisa la respuesta en la web y la versión de OpenClaw.');
}

// Flat typed evidence avoids embedding diagnostic JSON in the model response.
// JSON is still produced locally after the redacted export, never sent through it.
export function parseFlatEvidence(text) {
  if (text.length > 12000) return null;
  const result = {schema:1};
  for (const system of HEALTH_SYSTEMS) result[system] = {checks:{}};
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(proxmox|homeassistant|truenas)\.([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || seen.has(m[1] + '.' + m[2])) return null;
    const [, system, field, value] = m;
    seen.add(system + '.' + field);
    if (field === 'coverage') {
      if (!['complete','partial','missing'].includes(value)) return null;
      result[system].coverage = value;
    } else if (field === 'source') {
      if (value.length > 300 || /[{}\[\]]/.test(value)) return null;
      result[system].source = value;
    } else {
      if (!Object.hasOwn(HEALTH_CHECKS[system], field)) return null;
      let parsed = null;
      if (value === 'null') parsed = null;
      else if (HEALTH_CHECKS[system][field] === 'bool') {
        if (!['true','false'].includes(value)) return null;
        parsed = value === 'true';
      } else {
        if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
        parsed = Number(value);
        if (!Number.isFinite(parsed)) return null;
      }
      result[system].checks[field] = parsed;
    }
  }
  return seen.size ? result : null;
}

export function attachHealth(fullText, generatedAt) {
  assertUsableReport(fullText);
  // Legacy reports are preserved; templates render unknown when no status block exists.
  const matches = [...fullText.matchAll(/^\x60\x60\x60homelab-evidence(-v2)?\r?\n([\s\S]*?)^\x60\x60\x60[ \t]*$/gm)];
  if (!matches.length && !/^## Estado general[ \t]*$/m.test(fullText) && !fullText.includes('HOMELAB_STATUS_V1')) return fullText;
  let evidence = null;
  if (matches.length === 1 && matches[0][2].length <= 12000) {
    try { evidence = matches[0][1] === '-v2' ? parseFlatEvidence(matches[0][2]) : JSON.parse(matches[0][2]); } catch { /* Unknown, never infer from prose. */ }
  }
  const statuses = evaluateHealth(evidence);
  const data = {schema:1, generated_at:generatedAt, systems:statuses};
  // Never accept a model-authored machine status block.
  let body = fullText.replace(/<!-- HOMELAB_STATUS_V1\n[\s\S]*?\nEND_HOMELAB_STATUS -->/g, '');
  body = body.replace(/^\x60\x60\x60homelab-evidence(?:-v2)?\r?\n[\s\S]*?^\x60\x60\x60[ \t]*$/gm, '');
  const heading = body.search(/^## Estado general[ \t]*$/m);
  if (heading >= 0) body = body.slice(0, heading);
  const cell = text => text.replace(/[|\r\n]/g, ' ');
  const table = ['## Estado general', '', '| Sistema | Estado | Motivo | Cobertura |',
    '| --- | --- | --- | --- |', ...[...HEALTH_SYSTEMS,'homelab'].map(s => {
      const r = statuses[s];
      return '| ' + HEALTH_LABELS[s] + ' | ' + r.state + ' | ' + cell(r.reason) + ' | ' + r.coverage + ' |';
    }), '', 'Estado del informe de ' + generatedAt + '; no es monitorización en tiempo real.',
    'Reglas automáticas sobre datos transcritos por el modelo; contrastar incidencias con las fuentes.',
    '', HEALTH_START + JSON.stringify(data) + HEALTH_END];
  return body.trim() + '\n\n' + table.join('\n');
}

export function buildReport(history, jobId, fullText) {
  const { good, latestStatus } = selectReportRun(history, jobId);
  const timestamp = e => Number(e.ts ?? e.runAtMs);
  if (typeof fullText !== 'string' || !fullText.trim()) throw Error('Falta el informe completo; no se usa summary');
  const report = attachHealth(fullText.trim(), new Date(timestamp(good)).toISOString());
  if (Buffer.byteLength(report) > 32768) throw Error('Informe superior a 32 KiB; no se trunca');
  return {
    schema: 1, job_id: jobId,
    report_id: String(good.runId ?? good.sessionId ?? `${jobId}:${timestamp(good)}`),
    generated_at: new Date(timestamp(good)).toISOString(),
    last_run_status: latestStatus,
    report,
  };
}


export function resolveReportSession(list, run, agentId) {
  if (!Array.isArray(list?.sessions) || typeof run.sessionId !== 'string' || !run.sessionId)
    throw Error('Falta el identificador de sesión del informe');
  const matches = list.sessions.filter(s => s.sessionId === run.sessionId
    && typeof s.key === 'string' && s.key.startsWith('agent:' + agentId + ':')
    && (!s.agentId || s.agentId === agentId));
  if (matches.length !== 1) throw Error('No se encuentra una sesión única para la ejecución; se conserva el sensor');
  return matches[0].key;
}

export function extractChatReport(history, run, key) {
  if (history?.sessionId !== run.sessionId || history?.sessionKey !== key
      || !Array.isArray(history?.messages))
    throw Error('El historial del Gateway no corresponde a la sesión solicitada; se conserva el sensor');
  const start = Number(run.runAtMs), end = Number(run.ts);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start)
    throw Error('Faltan las fechas de la ejecución para identificar el informe');
  const candidates = history.messages.filter(m =>
    m?.role === 'assistant' && m.stopReason === 'stop'
    && typeof m.timestamp === 'number' && Number.isFinite(m.timestamp)
    && m.timestamp >= start && m.timestamp <= end
    // Announce/injected copies are not the generated final response.
    && !m.senderSession && !m.idempotencyKey && !m.provenance
  ).sort((a,b) => a.timestamp - b.timestamp);
  const message = candidates.at(-1);
  if (!message)
    throw Error('No hay respuesta final de esta ejecución en chat.history; se conserva el sensor');
  if (candidates.length > 1 && candidates.at(-2).timestamp === message.timestamp)
    throw Error('Hay respuestas finales ambiguas; se conserva el sensor');
  if (message.__openclaw?.truncated === true || message.truncated === true
      || (Array.isArray(message.content) && message.content.some(b => b?.truncated === true || b?.__openclaw?.truncated === true)))
    throw Error('El Gateway devuelve una respuesta truncada; se conserva el sensor');
  const text = Array.isArray(message.content)
    ? message.content.filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('\n\n').trim()
    : typeof message.content === 'string' ? message.content.trim() : '';
  if (!text || /\[chat\.history omitted:/i.test(text))
    throw Error('Falta el informe completo en chat.history; se conserva el sensor');
  assertUsableReport(text);
  return text;
}

function cli(args) {
  return JSON.parse(execFileSync('openclaw', args, {
    encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

export function readFullReport(run, agentId, call = cli) {
  const list = call(['sessions', 'list', '--agent', agentId, '--limit', 'all', '--json']);
  const key = resolveReportSession(list, run, agentId);
  // Same authenticated, read-only history surface used by the web UI.
  // Do not use diagnostic exports or unredacted database reads.
  const history = call(['gateway', 'call', 'chat.history', '--json', '--params',
    JSON.stringify({agentId, sessionKey:key, limit:100, maxChars:65536})]);
  return extractChatReport(history, run, key);
}

export async function publishReport(payload, { url, token }) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    throw Error('URL de publicación no válida');
  if (!/^[a-f0-9]{64}$/i.test(token || '')) throw Error('Se requiere un token hexadecimal de 64 caracteres');
  const response = await fetch(target, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw Error(`Node-RED respondió HTTP ${response.status}`);
  const ack = await response.json();
  if (ack.ok !== true || ack.report_id !== payload.report_id)
    throw Error('Node-RED no confirmó la actualización del informe');
}

if (process.env.HOMELAB_PUBLISH_RUN === '1') {
  try {
    const jobId = process.env.HOMELAB_REPORT_JOB_ID || 'c2c20bac-2f48-4605-b64a-5f7dfd40c743';
    const agentId = process.env.HOMELAB_REPORT_AGENT_ID || 'homelab-observer';
    const history = cli(['automations', 'runs', jobId, '--limit', '20', '--json']);
    const { good } = selectReportRun(history, jobId);
    const payload = buildReport(history, jobId, readFullReport(good, agentId));
    await publishReport(payload, {
      url: process.env.HOMELAB_REPORT_URL || 'http://10.8.1.28:1880/homelab/report',
      token: process.env.HOMELAB_REPORT_TOKEN,
    });
    console.log(JSON.stringify({ published: true, generated_at: payload.generated_at,
      last_run_status: payload.last_run_status, report_source: 'chat.history',
      report_chars: payload.report.length }));
  } catch (error) {
    // Child process errors may contain full stdout/stderr, including reports.
    console.error(error?.spawnargs ? 'No se pudo consultar el historial del Gateway de OpenClaw' :
      error instanceof SyntaxError ? 'Respuesta JSON no válida' :
      error?.code ? 'No se pudo consultar el informe de OpenClaw' :
      String(error.message).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'));
    process.exitCode = 1;
  }
}
