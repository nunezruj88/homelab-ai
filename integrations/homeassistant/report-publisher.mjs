import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

export function buildReport(history, jobId, fullText) {
  const { good, latestStatus } = selectReportRun(history, jobId);
  const timestamp = e => Number(e.ts ?? e.runAtMs);
  if (typeof fullText !== 'string' || !fullText.trim()) throw Error('Falta el informe completo; no se usa summary');
  const report = fullText.trim();
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

export function extractReport(events, run) {
  const start = Number(run.runAtMs);
  const end = Number(run.ts);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start)
    throw Error('Faltan las fechas de la ejecución para identificar el informe');
  const candidates = events.filter(e => {
    const m = e?.data?.message;
    const ts = Date.parse(e?.ts);
    return e?.sessionId === run.sessionId && e.type === 'assistant.message'
      && m?.role === 'assistant' && m.stopReason === 'stop'
      && ts >= start && ts <= end;
  }).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const message = candidates.at(-1)?.data.message;
  // Only public text blocks, never thinking, tool results or runtime snapshots.
  const text = Array.isArray(message?.content)
    ? message.content.filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('\n\n').trim()
    : typeof message?.content === 'string' ? message.content.trim() : '';
  if (!text) throw Error('No hay respuesta final completa para esa ejecución; se conserva el sensor');
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
  // Unique private workspace; exports are transient and never enter the repo.
  const workspace = mkdtempSync(join(tmpdir(), 'homelab-report-'));
  try {
    const bundle = call(['sessions', 'export-trajectory', '--agent', agentId,
      '--session-key', key, '--workspace', workspace, '--output', 'report', '--json']);
    const expected = join(workspace, '.openclaw', 'trajectory-exports', 'report');
    if (bundle.sessionId !== run.sessionId || typeof bundle.outputDir !== 'string'
      || resolve(bundle.outputDir) !== resolve(expected))
      throw Error('La exportación no corresponde a la sesión o directorio solicitado');
    const file = join(expected, 'events.jsonl');
    if (statSync(file).size > 32 * 1024 * 1024) throw Error('Exportación superior a 32 MiB');
    const events = readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
      .map(l => JSON.parse(l));
    return extractReport(events, run);
  } finally {
    // Delete only the directory created by this invocation, not the returned path.
    rmSync(workspace, { recursive: true, force: true });
  }
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
      last_run_status: payload.last_run_status, report_source: 'trajectory',
      report_chars: payload.report.length }));
  } catch (error) {
    // Child process errors may contain full stdout/stderr, including reports.
    console.error(error?.spawnargs ? 'No se pudo consultar o exportar la sesión de OpenClaw' :
      error instanceof SyntaxError ? 'Respuesta JSON no válida' :
      error?.code ? 'No se pudo leer o limpiar la exportación temporal' :
      String(error.message).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'));
    process.exitCode = 1;
  }
}
