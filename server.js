#!/usr/bin/env node
/*
 * Local server: serves the trainer and keeps stats in stats.json.
 *   GET /api/stats   returns the saved JSON ({} if none yet)
 *   PUT /api/stats   replaces it
 * Listens on 127.0.0.1 only. PORT overrides the default 8231.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};
const MAX_BODY = 1024 * 1024;

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function createServer({ root, statsFile }) {
  root = path.resolve(root);
  let writes = Promise.resolve();

  // Writes go through a queue and a temp file so the JSON is never half-written.
  const save = (data) => {
    writes = writes.then(async () => {
      const tmp = statsFile + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
      await fs.promises.rename(tmp, statsFile);
    });
    return writes;
  };

  function stats(req, res) {
    if (req.method === 'GET') {
      fs.readFile(statsFile, 'utf8', (err, text) => {
        if (err && err.code === 'ENOENT') return send(res, 200, '{}', TYPES['.json']);
        if (err) return send(res, 500, 'Could not read stats');
        send(res, 200, text, TYPES['.json']);
      });
      return;
    }
    if (req.method !== 'PUT') return send(res, 405, 'Method not allowed');
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(res, 413, 'Too large');
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let data;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return send(res, 400, 'Invalid JSON');
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return send(res, 400, 'Expected a JSON object');
      save(data).then(() => send(res, 204, ''), () => send(res, 500, 'Could not write stats'));
    });
  }

  function serveStatic(pathname, res) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch (e) {
      return send(res, 400, 'Bad path');
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    const hidden = path.relative(root, file).split(path.sep).some((part) => part.startsWith('.'));
    if (!file.startsWith(root + path.sep) || hidden) return send(res, 404, 'Not found');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'Not found');
      send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  }

  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/stats') return stats(req, res);
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    serveStatic(pathname, res);
  });
}

if (require.main === module) {
  const root = __dirname;
  const statsFile = path.join(root, 'stats.json');
  const port = Number(process.env.PORT) || 8231;
  createServer({ root, statsFile })
    .on('error', (e) => {
      console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Try PORT=8232 node server.js` : e.message);
      process.exit(1);
    })
    .listen(port, '127.0.0.1', () => {
      console.log(`x86 prep: http://localhost:${port}`);
      console.log(`Stats file: ${statsFile}`);
      console.log('Ctrl+C to stop.');
    });
}

module.exports = { createServer };
