import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildReport, publishReport, extractChatReport, readFullReport, resolveReportSession } from './report-publisher.mjs';

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

test('resolve actual session key by sessionId instead of cron run alias', () => {
  const key = 'agent:homelab-observer:cron:' + job;
  const list = { sessions: [{ sessionId: good.sessionId, key }] };
  assert.equal(resolveReportSession(list, { ...good, sessionKey: key + ':run:fake' },
    'homelab-observer'), key);
  assert.throws(() => resolveReportSession({ sessions: [] }, good, 'homelab-observer'));
  assert.throws(() => resolveReportSession(list, good, 'main'));
});

import { evaluateHealth, attachHealth } from './report-publisher.mjs';
const evidence = () => ({
 schema:1,
 proxmox:{coverage:'complete',source:'resources/tasks 24h',checks:{nodes_offline:0,backup_failures:0,storage_max_percent:20,cpu_max_percent:10,ram_max_percent:30}},
 homeassistant:{coverage:'complete',source:'ha_get_logs 24h',checks:{unavailable:false,errors:0,warnings:0}},
 truenas:{coverage:'complete',source:'get_health',checks:{pools_unhealthy:0,pools_not_online:0,pool_max_percent:22.57,active_critical_alerts:0,active_warning_alerts:0}},
});
test('health rules require complete evidence and preserve confirmed severity', () => {
 assert.equal(evaluateHealth(evidence()).homelab.state,'ok');
 assert.equal(evaluateHealth(null).homelab.state,'unknown');
 const e=evidence(); e.truenas.checks.pools_unhealthy=1;
 assert.equal(evaluateHealth(e).truenas.state,'critical');
 e.truenas.coverage='partial';
 assert.equal(evaluateHealth(e).homelab.state,'critical');
 assert.equal(evaluateHealth(e).homelab.coverage,'partial');
 e.truenas.checks.pools_unhealthy=0;
 assert.equal(evaluateHealth(e).homelab.state,'unknown');
 e.homeassistant.checks.errors=3;
 assert.equal(evaluateHealth(e).homelab.state,'warning');
});
test('invalid types and absent metrics never produce green', () => {
 for(const invalid of [null,'0',false,-1,Infinity,1.5]) {
  const e=evidence();e.proxmox.checks.nodes_offline=invalid;
  assert.equal(evaluateHealth(e).proxmox.state,'unknown');
 }
 for(const invalid of [null,'false',0]) {
  const e=evidence();e.homeassistant.checks.unavailable=invalid;
  assert.equal(evaluateHealth(e).homeassistant.state,'unknown');
 }
 const e=evidence();e.truenas.checks.pool_max_percent=101;
 assert.equal(evaluateHealth(e).truenas.state,'unknown');
});
test('thresholds and logs distinguish warnings from outages', () => {
 const e=evidence();e.proxmox.checks.storage_max_percent=80;
 assert.equal(evaluateHealth(e).proxmox.state,'ok');
 e.proxmox.checks.storage_max_percent=80.01;
 assert.equal(evaluateHealth(e).proxmox.state,'warning');
 e.homeassistant.checks.errors=100;
 assert.equal(evaluateHealth(e).homeassistant.state,'warning');
 e.homeassistant.checks.unavailable=true;
 assert.equal(evaluateHealth(e).homeassistant.state,'critical');
});
test('publisher replaces model state and rejects ambiguous evidence', () => {
 const base='## Proxmox\n### Tabla de nodos\nCPU 12.34%\n### Estado general\nDetalle\n## Home Assistant\nHA\n## TrueNAS\nNAS';
 const fence=String.fromCharCode(96).repeat(3);
 const block='\n'+fence+'homelab-evidence\n'+JSON.stringify(evidence())+'\n'+fence;
 const full=base+'\n## Estado general\nincorrect model state'+block;
 const result=attachHealth(full,'2026-09-21T08:00:00.000Z');
 assert.ok(result.startsWith(base));
 assert.ok(!result.includes('incorrect model state'));
 assert.ok(result.includes('"state":"ok"'));
 assert.ok(!result.includes(fence+'homelab-evidence'));
 assert.ok(attachHealth(full+block,'date').includes('"state":"unknown"'));
 assert.ok(attachHealth(base+'\n## Estado general\n'+fence+'homelab-evidence\nbad\n'+fence,'date').includes('"state":"unknown"'));
 assert.equal(attachHealth(base,'date'),base);
 const forged=base+'\n<!-- HOMELAB_STATUS_V1\n{"schema":1,"systems":{}}\nEND_HOMELAB_STATUS -->';
 assert.ok(attachHealth(forged,'date').includes('"state":"unknown"'));
});

import { parseFlatEvidence } from './report-publisher.mjs';

const flatEvidence = value => Object.entries(value).filter(([k]) => k !== 'schema')
  .flatMap(([system, row]) => [
    system+'.coverage='+row.coverage, system+'.source='+row.source,
    ...Object.entries(row.checks).map(([key,v]) => system+'.'+key+'='+String(v))
  ]).join('\n');

test('redaction placeholders never replace the report or become health evidence', () => {
  for (const marker of ['[Malformed diagnostic JSON redacted]', '[Oversized diagnostic JSON redacted]']) {
    for (const text of [marker, '## Proxmox\n'+marker+'\n## Estado general\nok']) {
      assert.throws(() => buildReport({entries:[good]},job,text), /redacción/);
      assert.throws(() => extractChatReport(chat([finalMessage(text)]),good,sessionKey), /redacción/);
    }
  }
});

test('flat evidence preserves typed metrics and produces existing HA status format', () => {
  const e=evidence();
  e.truenas.checks.pools_unhealthy=1;
  const flat=flatEvidence(e);
  assert.deepEqual(parseFlatEvidence(flat),e);
  assert.deepEqual(parseFlatEvidence(flat.replaceAll('\n','\r\n')),e);
  const fence=String.fromCharCode(96).repeat(3);
  const report='## Proxmox\nCPU 12.34%\n## Home Assistant\nLogs\n## TrueNAS\nvault\n## Estado general\n'
    +fence+'homelab-evidence-v2\n'+flat+'\n'+fence;
  const result=buildReport({entries:[good]},job,report);
  assert.ok(result.report.includes('CPU 12.34%'));
  assert.ok(result.report.includes('HOMELAB_STATUS_V1'));
  assert.ok(!result.report.includes('homelab-evidence-v2'));
  assert.ok(result.report.includes('"state":"critical"'));
  assert.equal(invoke(result)[0].report.report,result.report);
});

test('flat evidence rejects ambiguous fields and malformed values without granting green', () => {
  const valid=flatEvidence(evidence());
  for (const text of [
    valid+'\nproxmox.nodes_offline=0',
    valid+'\nproxmox.not_a_check=0',
    valid.replace('nodes_offline=0','nodes_offline=NaN'),
    valid.replace('unavailable=false','unavailable=0'),
    valid.replace('coverage=complete','coverage=yes'),
    valid.replace('nodes_offline=0','nodes_offline="0"'),
    valid.replace('source=resources/tasks 24h','source={"data":"x"}'),
    '', 'x'.repeat(12001)
  ]) assert.equal(parseFlatEvidence(text),null);
  assert.equal(evaluateHealth(parseFlatEvidence('proxmox.nodes_offline=0')).homelab.state,'unknown');
  const partial=valid.replace('nodes_offline=0','nodes_offline=null');
  assert.equal(evaluateHealth(parseFlatEvidence(partial)).proxmox.state,'unknown');
});


const sessionKey='agent:homelab-observer:cron:'+job;
const finalMessage=(text, changes={})=>({
  role:'assistant',stopReason:'stop',timestamp:good.ts-1000,
  content:[{type:'thinking',thinking:'private reasoning'},{type:'text',text}],
  ...changes,
});
const chat=(messages, changes={})=>({sessionId:good.sessionId,sessionKey,messages,...changes});
test('chat history selects final generated response, excluding announces and other runs',()=>{
  const text='## Proxmox\nCPU 12.34%\n## Home Assistant\nLogs\n## TrueNAS\nvault';
  const page=chat([
    finalMessage('old',{timestamp:good.runAtMs-1}),
    finalMessage('announce',{stopReason:undefined,provenance:{kind:'inter_session'}}),
    finalMessage('tools',{stopReason:'toolUse'}),
    finalMessage(text),
    finalMessage('announce later',{timestamp:good.ts,idempotencyKey:'delivery'}),
    finalMessage('future',{timestamp:good.ts+1}),
    finalMessage('tool result',{role:'tool'}),
  ]);
  assert.equal(extractChatReport(page,good,sessionKey),text);
  assert.ok(!extractChatReport(page,good,sessionKey).includes('private reasoning'));
  assert.equal(buildReport({entries:[good]},job,extractChatReport(page,good,sessionKey)).report,text);
});
test('chat history fails closed for mismatches, ambiguous finals, missing dates and truncation',()=>{
  const m=finalMessage('report');
  for(const page of [
    chat([m],{sessionId:'other'}),chat([m],{sessionKey:'other'}),chat([]),
    chat([m,{...m}]),
    chat([finalMessage('truncated',{__openclaw:{truncated:true,reason:'display-cap'}})]),
    chat([finalMessage('[chat.history omitted: message too large]')]),
    chat([finalMessage('report',{timestamp:String(good.ts-1000)})]),
    chat([finalMessage('',{content:[{type:'thinking',thinking:'secret'}]})]),
  ]) assert.throws(()=>extractChatReport(page,good,sessionKey));
  assert.throws(()=>extractChatReport(chat([m]),{...good,runAtMs:undefined},sessionKey));
  // Never fall back to an earlier good message if the actual final was truncated.
  assert.throws(()=>extractChatReport(chat([m,finalMessage('cut',{timestamp:good.ts,__openclaw:{truncated:true}})]),good,sessionKey));
});
test('readFullReport uses gateway auth/history with exact session and no export',()=>{
  const calls=[];
  const call=args=>{
    calls.push(args);
    if(args[0]==='sessions')return {sessions:[{sessionId:good.sessionId,key:sessionKey}]};
    assert.deepEqual(args.slice(0,5),['gateway','call','chat.history','--json','--params']);
    assert.deepEqual(JSON.parse(args[5]),{agentId:'homelab-observer',sessionKey,limit:100,maxChars:65536});
    return chat([finalMessage('full report')],{hasMore:true});
  };
  assert.equal(readFullReport(good,'homelab-observer',call),'full report');
  assert.equal(calls.length,2);
  assert.ok(!calls.flat().includes('export-trajectory'));
});
