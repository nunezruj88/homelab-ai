import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

export function normalize(payload) {
  let changed = 0;
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (message?.role === 'assistant' && message.content === null &&
          Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        message.content = '';
        changed++;
      }
    }
  }
  return changed;
}

// The upstream URL is operator-controlled, never taken from a client request.
export function createServer({ upstream, model, log = console.log,
  maxBytes = 8 * 1024 * 1024, timeoutMs = 120000 }) {
  const target = new URL(upstream);
  const transport = target.protocol === 'https:' ? https : http;
  return http.createServer((req, res) => {
    const reply = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: { message } }));
    };
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      reply(404, 'Route not available');
      return;
    }
    if (!/^Bearer \S+$/i.test(req.headers.authorization || '')) {
      reply(401, 'Bearer token required');
      return;
    }
    let bytes = 0;
    const chunks = [];
    let rejected = false;
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        rejected = true;
        chunks.length = 0;
        reply(413, 'Request too large');
      } else chunks.push(chunk);
    });
    req.on('error', () => { /* No payload or credential logging. */ });
    req.on('end', () => {
      req.setTimeout(0);
      if (rejected) return;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw Error();
      } catch {
        reply(400, 'Invalid JSON object');
        return;
      }
      if (payload.model !== model) {
        reply(400, 'Model not enabled for this experiment');
        return;
      }
      const changed = normalize(payload);
      const body = JSON.stringify(payload);
      const start = Date.now();
      // Forward only the authorization and content headers needed by Cloudflare.
      // No redirects, automatic retries, arbitrary hosts or request dumps.
      const out = transport.request(target, {
        method: 'POST',
        headers: {
          Authorization: req.headers.authorization,
          'Content-Type': 'application/json',
          Accept: payload.stream ? 'text/event-stream' : 'application/json',
          'Accept-Encoding': 'identity',
          'Content-Length': Buffer.byteLength(body),
        },
      });
      const deadline = setTimeout(() => out.destroy(new Error('timeout')), timeoutMs);
      out.on('response', response => {
        const headers = { 'Content-Type': response.headers['content-type'] || 'application/json',
          'Cache-Control': 'no-store' };
        if (response.headers['cf-ray']) headers['cf-ray'] = response.headers['cf-ray'];
        if (response.headers['retry-after']) headers['retry-after'] = response.headers['retry-after'];
        res.writeHead(response.statusCode, headers);
        res.flushHeaders();
        log(JSON.stringify({ upstreamStatus: response.statusCode, normalized: changed,
          headerLatencyMs: Date.now() - start }));
        response.on('error', () => res.destroy());
        response.on('end', () => clearTimeout(deadline));
        response.on('close', () => clearTimeout(deadline));
        // Preserve SSE bytes and JSON/error bodies unchanged, with backpressure.
        response.pipe(res);
      });
      out.on('error', () => {
        clearTimeout(deadline);
        if (!res.headersSent) reply(502, 'Upstream connection failed or timed out');
        else res.destroy();
      });
      res.on('close', () => {
        clearTimeout(deadline);
        out.destroy();
      });
      out.end(body);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!/^[a-fA-F0-9]{32}$/.test(account || '')) {
    console.error('CLOUDFLARE_ACCOUNT_ID must contain 32 hexadecimal characters');
    process.exit(1);
  }
  const server = createServer({
    upstream: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`,
    model: '@cf/qwen/qwen3-30b-a3b-fp8',
  });
  server.listen(8080, '0.0.0.0');
  process.on('SIGTERM', () => {
    server.close();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
