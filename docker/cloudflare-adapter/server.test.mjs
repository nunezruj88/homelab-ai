import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, normalize, normalizeStream } from './server.mjs';
import { Readable } from 'node:stream';

async function replay(chunks, options) {
  const stream = Readable.from(chunks).pipe(normalizeStream(options));
  let output = '';
  for await (const chunk of stream) output += chunk.toString();
  return output;
}

test('numeric content including zero survives fragmented UTF-8 SSE; metadata stays numeric', async () => {
  const event = content => 'data: ' + JSON.stringify({ choices: [{ index: 0,
    delta: { content } }], usage: { completion_tokens: 12 } }) + '\r\n\r\n';
  const input = ['CPU ', 1, 2, '.', 3, 4, '%, RAM ', 0, '%, nodos ', 4, '. España']
    .map(event).join('') + 'data: [DONE]\r\n\r\n';
  const output = await replay(Array.from(Buffer.from(input), b => Buffer.from([b])));
  const events = output.split('\r\n\r\n').filter(x => x.startsWith('data: {'))
    .map(x => JSON.parse(x.slice(6)));
  assert.equal(events.map(x => x.choices[0].delta.content).join(''), 'CPU 12.34%, RAM 0%, nodos 4. España');
  assert.ok(events.every(x => typeof x.choices[0].delta.content === 'string'));
  assert.ok(events.every(x => x.choices[0].index === 0 && x.usage.completion_tokens === 12));
  assert.ok(output.endsWith('data: [DONE]\r\n\r\n'));
});

test('multiline data retains SSE metadata; tool calls and malformed events pass through', async () => {
  const input = ': keep\nevent: message\nid: 7\ndata: {"choices":\ndata: [{"delta":{"content":0}}]}\n\n';
  assert.equal(await replay([input]), ': keep\nevent: message\nid: 7\ndata: {"choices":[{"delta":{"content":"0"}}]}\n\n');
  const unchanged = 'data: {"choices":[{"delta":{"content":null,"tool_calls":[{"index":0,"function":{"arguments":"123"}}]}}]}\n\ndata: not-json\n\n: final';
  assert.equal(await replay([unchanged]), unchanged);
});

test('oversized complete and incomplete SSE events are rejected', async () => {
  await assert.rejects(replay(['data: ' + 'x'.repeat(100)], { maxEventBytes: 32 }), /too large/);
  await assert.rejects(replay(['data: ' + 'x'.repeat(100) + '\n\n'], { maxEventBytes: 32 }), /too large/);
});

test('HTTP streaming normalizes numeric content and logs counts only', async t => {
  const { url, logs } = await fixture(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.end('data: {"choices":[{"delta":{"content":4}}]}\n\ndata: [DONE]\n\n');
  });
  const response = await send(url, { model, stream: true });
  assert.equal(await response.text(), 'data: {"choices":[{"delta":{"content":"4"}}]}\n\ndata: [DONE]\n\n');
  assert.ok(logs.some(line => JSON.parse(line).normalizedContentChunks === 1));
});

const model = '@cf/qwen/qwen3-30b-a3b-fp8';
const token = 'Bearer test-credential-not-real';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () =>
  resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => {
  server.closeAllConnections();
  server.close(resolve);
});
async function fixture(t, handle, options = {}) {
  const upstream = http.createServer(handle);
  const upstreamUrl = await listen(upstream);
  const logs = [];
  const adapter = createServer({ upstream: upstreamUrl + '/fixed', model,
    log: line => logs.push(line), ...options });
  const url = await listen(adapter);
  t.after(async () => { await close(adapter); await close(upstream); });
  return { url, logs };
}
function send(url, payload, headers = {}) {
  return fetch(url + '/v1/chat/completions', { method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload) });
}

test('only null assistant content with tool calls is changed', () => {
  const payload = { messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'assistant', tool_calls: [{ id: 'b' }] },
    { role: 'tool', content: null, tool_call_id: 'a' },
    { role: 'user', content: [{ type: 'text', text: 'keep' }] },
    { role: 'assistant', content: 'keep', tool_calls: [{ id: 'c' }] },
  ] };
  const expected = structuredClone(payload);
  expected.messages[0].content = '';
  assert.equal(normalize(payload), 1);
  assert.deepEqual(payload, expected);
  assert.equal(normalize(payload), 0);
});

test('real HTTP round trip preserves tools, identifiers, results and JSON response', async t => {
  const payload = { model, messages: [
    { role: 'user', content: 'PRIVATE-PROMPT' },
    { role: 'assistant', content: null, reasoning_content: 'keep', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'status', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"online":true}' }],
    tools: [{ type: 'function', function: { name: 'status' } }], stream: false };
  let observed;
  const { url, logs } = await fixture(t, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      observed = { path: req.url, auth: req.headers.authorization,
        cookie: req.headers.cookie, body: JSON.parse(Buffer.concat(chunks)) };
      res.setHeader('Content-Type', 'application/json');
      res.end('{"choices":[{"message":{"content":"online"}}]}');
    });
  });
  const result = await send(url, payload, { Cookie: 'must-not-forward' });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).choices[0].message.content, 'online');
  assert.equal(observed.path, '/fixed');
  assert.equal(observed.auth, token);
  assert.equal(observed.cookie, undefined);
  payload.messages[1].content = '';
  assert.deepEqual(observed.body, payload);
  assert.equal(JSON.parse(logs[0]).normalized, 1);
  assert.ok(!logs.join('').includes('PRIVATE-PROMPT'));
  assert.ok(!logs.join('').includes(token));
});

test('SSE is delivered before the upstream response finishes and bytes are preserved', async t => {
  let finish;
  const first = 'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1"}]}}]}\n\n';
  const last = 'data: [DONE]\n\n';
  const { url } = await fixture(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(first);
    finish = () => res.end(last);
  });
  const response = await send(url, { model, stream: true });
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.equal(new TextDecoder().decode(chunk.value), first);
  finish();
  let rest = '';
  for (;;) { const next = await reader.read(); if (next.done) break;
    rest += new TextDecoder().decode(next.value); }
  assert.equal(rest, last);
});

test('upstream errors are preserved without retries or logging the body', async t => {
  let requests = 0;
  const { url, logs } = await fixture(t, (req, res) => {
    requests++;
    req.resume();
    res.writeHead(400, { 'Content-Type': 'application/json', 'cf-ray': 'test-ray' });
    res.end('{"error":"PRIVATE-UPSTREAM-BODY"}');
  });
  const response = await send(url, { model });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cf-ray'), 'test-ray');
  assert.equal((await response.json()).error, 'PRIVATE-UPSTREAM-BODY');
  assert.equal(requests, 1);
  assert.ok(!logs.join('').includes('PRIVATE-UPSTREAM-BODY'));
});

test('missing auth, wrong model, other routes, invalid JSON and oversized bodies are rejected', async t => {
  let requests = 0;
  const { url } = await fixture(t, (req, res) => { requests++; req.resume(); res.end(); }, { maxBytes: 256 });
  assert.equal((await send(url, { model }, { Authorization: '' })).status, 401);
  assert.equal((await send(url, { model: 'other' })).status, 400);
  assert.equal((await fetch(url + '/v1/chat/completions?upstream=evil')).status, 404);
  assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST',
    headers: { Authorization: token }, body: '{' })).status, 400);
  assert.equal((await send(url, { model, content: 'a'.repeat(300) })).status, 413);
  assert.equal(requests, 0);
});

test('upstream timeout returns a generic 502', async t => {
  const { url } = await fixture(t, req => req.resume(), { timeoutMs: 50 });
  const response = await send(url, { model });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /timed out/);
});

test('health endpoint is local and does not call Cloudflare', async t => {
  const { url } = await fixture(t, () => assert.fail('Unexpected upstream request'));
  assert.deepEqual(await (await fetch(url + '/healthz')).json(), { status: 'ok' });
});

