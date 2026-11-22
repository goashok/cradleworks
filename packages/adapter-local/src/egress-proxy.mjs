// Egress proxy for one sandbox. Plain JavaScript with no dependencies: it runs inside a
// stock Node image, mounted read-only.
//
// It is the sandbox's only way out. HTTPS goes through CONNECT, plain HTTP is forwarded;
// either way the destination must match the allow-list in POLICY_FILE, which is re-read
// on every request so a policy change takes effect at once. Names that resolve to
// private, loopback or link-local addresses are refused unless that exact address is
// listed, so an allowed name cannot be pointed at the host or the local network.
// Every decision is one JSON line on stdout.

import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.PROXY_PORT ?? 3128);
const POLICY_FILE = process.env.POLICY_FILE ?? '/policy/allow.json';

function rules() {
  try {
    return JSON.parse(readFileSync(POLICY_FILE, 'utf8')).rules ?? [];
  } catch {
    return []; // unreadable policy = nothing allowed
  }
}

export function matches(rule, host, port) {
  const ports = rule.ports.length > 0 ? rule.ports : [80, 443];
  if (!ports.includes(port)) return false;
  return rule.subdomains ? host.endsWith(`.${rule.host}`) : host === rule.host;
}

export function isInternal(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isInternal(v.slice(7));
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/** Decides a destination; returns the address to connect to, or a reason to refuse. */
async function decide(rawHost, port) {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const rule = rules().find((r) => matches(r, host, port));
  if (!rule) return { allow: false, host, reason: 'not on the allow-list' };
  if (net.isIP(host)) return { allow: true, host, address: host }; // listed exactly
  let address;
  try {
    ({ address } = await lookup(host));
  } catch {
    return { allow: false, host, reason: 'name does not resolve' };
  }
  if (isInternal(address)) return { allow: false, host, address, reason: 'resolves to an internal address' };
  return { allow: true, host, address };
}

function log(entry) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url ?? '');
  } catch {
    res.writeHead(400).end('cradleworks egress proxy: absolute URL required\n');
    return;
  }
  if (url.protocol !== 'http:') {
    res.writeHead(400).end('cradleworks egress proxy: use CONNECT for https\n');
    return;
  }
  const port = Number(url.port || 80);
  const d = await decide(url.hostname, port);
  log({ method: req.method, host: d.host, port, decision: d.allow ? 'allow' : 'deny', ...(d.reason ? { reason: d.reason } : {}) });
  if (!d.allow) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end(`cradleworks egress proxy: ${d.host}:${port} ${d.reason}\n`);
    return;
  }
  const headers = { ...req.headers };
  delete headers['proxy-connection'];
  delete headers['proxy-authorization'];
  const upstream = http.request({ host: d.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, servername: d.host }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502).end(`cradleworks egress proxy: ${e.message}\n`);
    else res.destroy();
  });
  req.pipe(upstream);
});

server.on('connect', async (req, client, head) => {
  const target = req.url ?? '';
  const at = target.lastIndexOf(':');
  const host = at > 0 ? target.slice(0, at) : target;
  const port = at > 0 ? Number(target.slice(at + 1)) : 443;
  client.on('error', () => undefined);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const d = await decide(host, port);
  log({ method: 'CONNECT', host: d.host, port, decision: d.allow ? 'allow' : 'deny', ...(d.reason ? { reason: d.reason } : {}) });
  if (!d.allow) {
    client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\ncradleworks egress proxy: ${d.host}:${port} ${d.reason}\n`);
    return;
  }
  const upstream = net.connect(port, d.address, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
});

if (process.env.PROXY_NO_LISTEN !== '1') {
  server.listen(PORT, '0.0.0.0', () => log({ ready: true, port: PORT }));
}
