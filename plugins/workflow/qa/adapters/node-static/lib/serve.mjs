// Static server for a built web app (node-static serve). Serves QA_ROOT/<dist> on 127.0.0.1:QA_PORT.
// An extensionless path that is not a file falls back to index.html (SPA routes). A path with a '..'
// segment is refused with 403. Node stdlib only.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const settings = JSON.parse(process.env.QA_SETTINGS || '{}');
const dist = typeof settings.dist === 'string' && settings.dist ? settings.dist : 'dist';
const root = path.resolve(process.env.QA_ROOT || '.', dist);
const port = Number(process.env.QA_PORT);

const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};
const isDir = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};

if (!isDir(root)) {
  console.error(`no ${dist}/ — run build first`);
  process.exit(1);
}
if (!Number.isInteger(port) || port <= 0) {
  console.error('QA_PORT is not set to a port');
  process.exit(2);
}

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendFile(req, res, file) {
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': fs.statSync(file).size,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  // Checked on the raw path: URL parsing would fold '/../x' to '/x' before the check could see it.
  const rawPath = req.url.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return send(res, 400, 'bad request');
  }
  if (decoded.split(/[\\/]/).includes('..')) return send(res, 403, 'forbidden');
  const file = path.join(root, ...decoded.split('/').filter((s) => s && s !== '.'));
  if (isFile(file)) return sendFile(req, res, file);
  if (isDir(file) && isFile(path.join(file, 'index.html'))) return sendFile(req, res, path.join(file, 'index.html'));
  const index = path.join(root, 'index.html');
  if (!path.extname(decoded) && isFile(index)) return sendFile(req, res, index);
  return send(res, 404, 'not found');
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch {
    if (res.headersSent) res.destroy();
    else send(res, 500, 'server error');
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}`);
});
