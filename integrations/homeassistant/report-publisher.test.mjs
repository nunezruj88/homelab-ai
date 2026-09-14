import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildReport, publishReport } from './report-publisher.mjs';

const job = 'c2c20bac-2f48-4605-b64a-5f7dfd40c743';
const token = 'a'.repeat(64);
const time = Date.now() - 60000;
const good = { jobId: job, status: 'ok', ts: time, sessionId: 'example-session',
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
    { ...good, jobId: 'another-job', ts: time + 2000 }] }, job);
  assert.equal(report.report, good.summary);
  assert.equal(report.generated_at, new Date(time).toISOString());
  assert.equal(report.last_run_status, 'error');
  assert.equal(invoke(report)[0].report.report, good.summary);
});

test('missing, failed, empty and oversized reports do not overwrite the sensor', () => {
  for (const value of [{}, { entries: [] }, { entries: [{ ...good, status: 'error' }] },
    { entries: [{ ...good, summary: '' }] }, { entries: [{ ...good, summary: 'x'.repeat(32769) }] }])
    assert.throws(() => buildReport(value, job));
});

test('receiver rejects missing credentials, unexpected jobs and invalid payloads', () => {
  const p = buildReport({ entries: [good] }, job);
  assert.equal(invoke(p, '')[1].statusCode, 401);
  assert.equal(invoke(p, 'Bearer ' + token, '')[1].statusCode, 503);
  for (const value of [{ ...p, job_id: 'other' }, { ...p, schema: 2 }, { ...p, report: '' },
    { ...p, report: 'é'.repeat(20000) }, { ...p, generated_at: 'invalid' },
    { ...p, generated_at: new Date(Date.now() + 3600000).toISOString() }])
    assert.equal(invoke(value)[1].statusCode, 400);
});

test('HTTP round trip requires matching acknowledgement and passes bearer/body', async t => {
  const p = buildReport({ entries: [good] }, job);
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
