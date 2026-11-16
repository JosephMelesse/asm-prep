'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server.js');

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<p>hi</p>');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), 'secret');
  const statsFile = path.join(root, 'stats.json');
  const server = createServer({ root, statsFile });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, statsFile, root);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const put = (base, body) => fetch(base + '/api/stats', { method: 'PUT', body });

test('stats start empty, then round-trip through the file', () => withServer(async (base, statsFile) => {
  assert.deepStrictEqual(await (await fetch(base + '/api/stats')).json(), {});
  const data = { mode: 'trace', stats: { 't:mul': { right: 3, total: 4 } } };
  assert.strictEqual((await put(base, JSON.stringify(data))).status, 204);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(statsFile, 'utf8')), data);
  assert.deepStrictEqual(await (await fetch(base + '/api/stats')).json(), data);
}));

test('rejects malformed or non-object bodies and keeps the old file', () => withServer(async (base, statsFile) => {
  await put(base, '{"a":1}');
  assert.strictEqual((await put(base, '{not json')).status, 400);
  assert.strictEqual((await put(base, '[1,2]')).status, 400);
  assert.strictEqual((await put(base, 'null')).status, 400);
  assert.strictEqual((await put(base, 'x'.repeat(2 * 1024 * 1024))).status, 413);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(statsFile, 'utf8')), { a: 1 });
}));

test('many overlapping saves leave valid JSON holding the last one', () => withServer(async (base, statsFile) => {
  await Promise.all(Array.from({ length: 40 }, (_, i) => put(base, JSON.stringify({ n: i, pad: 'x'.repeat(5000) }))));
  await put(base, JSON.stringify({ n: 'last' }));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(statsFile, 'utf8')), { n: 'last' });
  assert.ok(!fs.existsSync(statsFile + '.tmp'));
}));

test('serves the app but nothing outside it or hidden', () => withServer(async (base) => {
  const home = await fetch(base + '/');
  assert.strictEqual(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.strictEqual((await fetch(base + '/%2e%2e/%2e%2e/etc/passwd')).status, 404);
  assert.strictEqual((await fetch(base + '/.git/config')).status, 404);
  assert.strictEqual((await fetch(base + '/missing.js')).status, 404);
  assert.strictEqual((await fetch(base + '/index.html', { method: 'DELETE' })).status, 405);
}));
