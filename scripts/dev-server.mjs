// Local development server: serves /public and routes /api/* to the same
// handler Netlify runs. Usage: DATABASE_URL=... APP_SECRET=... INSECURE_COOKIES=1 npm run dev
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/server/app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const port = Number(process.env.PORT || 8888);
process.env.SITE_URL ||= `http://localhost:${port}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), { ip: req.socket.remoteAddress });
      const headers = {};
      r.headers.forEach((val, k) => { if (k !== 'set-cookie') headers[k] = val; });
      const cookies = r.headers.getSetCookie?.() || [];
      if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(r.status, headers);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let p = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
    if (url.pathname === '/' ) p = path.join(root, 'index.html');
    const data = await fs.readFile(p).catch(() => null);
    if (!data) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
    res.end(data);
  } catch (e) {
    console.error(e);
    res.writeHead(500).end('error');
  }
}).listen(port, () => console.log(`Kickline dev server on http://localhost:${port}`));
