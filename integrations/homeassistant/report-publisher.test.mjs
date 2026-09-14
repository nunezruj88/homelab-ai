import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';
import { buildReport, publishReport, extractReport, readFullReport, resolveReportSession } from './report-publisher.mjs';

const job = 'c2c20bac-2f48-4605-b64a-5f7dfd40c743';
const token = 'a'.repeat(64);
const time = Date.now() - 60000;
const good = { jobId: job, status: 'ok', ts: time, runAtMs: time - 60000, sessionId: 'example-session',
  summary: 'CPU 12.34%, RAM 56.78%, nodos 4.\n\n## Home Assistant\nSin errores.' };
const flow = JSON.parse(readFileSync(new URL('./node-red-flow.json', import.meta.url)));
const validate = flow.find(n => n.id === 'hl_validate').func;
const invoke = (payload, auth = 'Bearer ' + token, configured = token) =>
  vm.runInNewContext('(function(){' + validate + '})()', {
    msg: { payload, req: { headers: { authorization: auth } } }, Buffer,
    env: { get: key => key === 'HOMELAB_REPORT_TOKEN' ? configured : job },
  });

test('select latest successful report without hiding a later error or changing digits', () => {
  const report = buildReport({ entries: [good, { ...good, ts: time + 1000, status: 'error', summary: 'Failure' },
    { ...good, jobId: 'another-job', ts: time + 2000 }] }, job, good.summary);
  assert.equal(report.report, good.summary);
  assert.equal(report.generated_at, new Date(time).toISOString());
  assert.equal(report.last_run_status, 'error');
  assert.equal(invoke(report)[0].report.report, good.summary);
});

test('missing, failed, empty and oversized reports do not overwrite the sensor', () => {
  for (const value of [{}, { entries: [] }, { entries: [{ ...good, status: 'error' }] }])
    assert.throws(() => buildReport(value, job, good.summary));
  for (const text of [undefined, '', 'x'.repeat(32769)])
    assert.throws(() => buildReport({ entries: [good] }, job, text));
});

test('receiver rejects missing credentials, unexpected jobs and invalid payloads', () => {
  const p = buildReport({ entries: [good] }, job, good.summary);
  assert.equal(invoke(p, '')[1].statusCode, 401);
  assert.equal(invoke(p, 'Bearer ' + token, '')[1].statusCode, 503);
  for (const value of [{ ...p, job_id: 'other' }, { ...p, schema: 2 }, { ...p, report: '' },
    { ...p, report: 'é'.repeat(20000) }, { ...p, generated_at: 'invalid' },
    { ...p, generated_at: new Date(Date.now() + 3600000).toISOString() }])
    assert.equal(invoke(value)[1].statusCode, 400);
});

test('HTTP round trip requires matching acknowledgement and passes bearer/body', async t => {
  const p = buildReport({ entries: [good] }, job, good.summary);
  let mode = 'ok';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), p);
    if (mode === 'redirect') { res.writeHead(302, { Location: '/other' }); res.end(); return; }
    res.writeHead(mode === 'fail' ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, report_id: mode === 'wrong-id' ? 'other' : p.report_id }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const options = { token, url: `http://127.0.0.1:${server.address().port}/homelab/report` };
  await publishReport(p, options);
  for (const value of ['wrong-id', 'fail', 'redirect']) {
    mode = value;
    await assert.rejects(publishReport(p, options));
  }
});

test('flow only updates the dedicated sensor and returns success downstream of it', () => {
  assert.deepEqual(flow.find(n => n.id === 'hl_sensor').wires, [['hl_ack']]);
  assert.equal(flow.filter(n => n.type === 'ha-sensor').length, 1);
  assert.ok(!flow.some(n => ['api-call-service', 'exec', 'debug'].includes(n.type)));
  assert.ok(!JSON.stringify(flow).includes(token));
  for (const node of flow) for (const targets of node.wires || []) for (const id of targets)
    assert.ok(flow.some(other => other.id === id));
});

const finalEvent = (text, overrides = {}) => ({
  type: 'assistant.message', sessionId: good.sessionId,
  ts: new Date(time - 1000).toISOString(),
  data: { message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'thinking', thinking: 'private reasoning' },
      { type: 'text', text }] } }, ...overrides,
});

test('full trajectory preserves HA section beyond summary and excludes other events/runs', () => {
  const full = '## Proxmox\n' + 'CPU 12.34%\n'.repeat(300)
    + '\n## Home Assistant\nErrores categorizados\n## Acciones\nRevisar integración.';
  const events = [
    finalEvent('wrong session', { sessionId: 'other' }),
    finalEvent('old report', { ts: new Date(good.runAtMs - 1).toISOString() }),
    { type: 'model.completed', data: { assistantTexts: ['runtime text'] } },
    finalEvent(full),
    finalEvent('future report', { ts: new Date(good.ts + 1).toISOString() }),
  ];
  const text = extractReport(events, good);
  assert.equal(text, full);
  const payload = buildReport({ entries: [{ ...good, summary: full.slice(0, 2000) + '…' }] }, job, text);
  assert.equal(invoke(payload)[0].report.report, full);
  assert.ok(!payload.report.includes('private reasoning'));
  assert.throws(() => extractReport([], good));
  assert.throws(() => extractReport(events, { ...good, runAtMs: undefined }));
  assert.throws(() => extractReport([finalEvent('tool', { data: {
    message: { role: 'assistant', stopReason: 'toolUse', content: [{type:'text',text:'tool'}] }
  } })], good));
});

test('resolve actual session key by sessionId instead of cron run alias', () => {
  const key = 'agent:homelab-observer:cron:' + job;
  const list = { sessions: [{ sessionId: good.sessionId, key }] };
  assert.equal(resolveReportSession(list, { ...good, sessionKey: key + ':run:fake' },
    'homelab-observer'), key);
  assert.throws(() => resolveReportSession({ sessions: [] }, good, 'homelab-observer'));
  assert.throws(() => resolveReportSession(list, good, 'main'));
});

test('CLI export reads only matching session and cleans private workspace on success/failure', () => {
  for (const mode of ['ok', 'wrong-session', 'broken-json', 'export-failed', 'wrong-path']) {
    let workspace;
    const call = args => {
      if (args[1] === 'list') return { sessions: [{
        sessionId: good.sessionId, key: 'agent:homelab-observer:cron:' + job }] };
      workspace = args[args.indexOf('--workspace') + 1];
      assert.equal(args[args.indexOf('--session-key') + 1], 'agent:homelab-observer:cron:' + job);
      if (mode === 'export-failed') throw Error('Export failed');
      const outputDir = join(workspace, '.openclaw', 'trajectory-exports', 'report');
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, 'events.jsonl'), mode === 'broken-json'
        ? 'invalid' : JSON.stringify(finalEvent(good.summary)) + '\n');
      return { outputDir: mode === 'wrong-path' ? workspace : outputDir,
        sessionId: mode === 'wrong-session' ? 'other' : good.sessionId };
    };
    if (mode === 'ok') assert.equal(readFullReport(good, 'homelab-observer', call), good.summary);
    else assert.throws(() => readFullReport(good, 'homelab-observer', call));
    assert.equal(existsSync(workspace), false);
  }
});
