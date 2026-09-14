import { execFileSync } from 'node:child_process';

export function buildReport(history, jobId) {
  const entries = Array.isArray(history) ? history : history?.entries;
  if (!Array.isArray(entries)) throw Error('Formato de historial no reconocido');
  const timestamp = e => Number(e.ts ?? e.runAtMs);
  const rows = entries.filter(e => e && (!e.jobId || e.jobId === jobId)
    && ['ok', 'error', 'skipped'].includes(e.status)
    && Number.isFinite(timestamp(e)) && timestamp(e) > 0)
    .sort((a, b) => timestamp(b) - timestamp(a));
  const good = rows.find(e => e.status === 'ok' && typeof e.summary === 'string' && e.summary.trim());
  if (!good) throw Error('No hay informe correcto con summary en las últimas 20 ejecuciones');
  const report = good.summary.trim();
  if (Buffer.byteLength(report) > 32768) throw Error('Informe superior a 32 KiB; no se trunca');
  return {
    schema: 1, job_id: jobId,
    report_id: String(good.runId ?? good.sessionId ?? `${jobId}:${timestamp(good)}`),
    generated_at: new Date(timestamp(good)).toISOString(),
    last_run_status: rows[0].status,
    report,
  };
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
    const raw = execFileSync('openclaw', ['automations', 'runs', jobId, '--limit', '20', '--json'],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const payload = buildReport(JSON.parse(raw), jobId);
    await publishReport(payload, {
      url: process.env.HOMELAB_REPORT_URL || 'http://10.8.1.28:1880/homelab/report',
      token: process.env.HOMELAB_REPORT_TOKEN,
    });
    console.log(JSON.stringify({ published: true, generated_at: payload.generated_at,
      last_run_status: payload.last_run_status }));
  } catch (error) {
    // Child process errors may contain full stdout/stderr, including reports.
    console.error(error?.spawnargs ? 'No se pudo consultar el historial de OpenClaw' :
      error instanceof SyntaxError ? 'Respuesta JSON no válida' :
      String(error.message).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'));
    process.exitCode = 1;
  }
}
