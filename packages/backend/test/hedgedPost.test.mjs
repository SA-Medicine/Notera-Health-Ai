import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hedgedPost } from '../src/services/LLMService.js';

function server(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s)); });
}
const url = (s) => `http://127.0.0.1:${s.address().port}/`;

test('hedge: slow first request, fast second → answers fast', async () => {
  let n = 0;
  const s = await server((req, res) => { n++; const d = n === 1 ? 3000 : 10; setTimeout(() => { res.statusCode = 200; res.end('{"ok":true}'); }, d); });
  const t0 = Date.now();
  const r = await hedgedPost(url(s), {}, '{}', 10000, 300);
  assert.equal(r.status, 200); assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`); assert.equal(n, 2);
  s.closeAllConnections?.(); s.close();
});

test('no hedge when first answers quickly', async () => {
  let n = 0;
  const s = await server((req, res) => { n++; res.end('{}'); });
  const r = await hedgedPost(url(s), {}, '{}', 5000, 500);
  assert.equal(r.status, 200); assert.equal(n, 1); s.close();
});

test('429 from first is not "usable" while hedge pending; returns the 429 if all fail', async () => {
  const s = await server((req, res) => { res.statusCode = 429; res.end('{"error":"quota"}'); });
  const r = await hedgedPost(url(s), {}, '{}', 5000, 300);
  assert.equal(r.status, 429); s.close();
});

test('overall timeout aborts', async () => {
  const s = await server(() => { /* never answer */ });
  await assert.rejects(hedgedPost(url(s), {}, '{}', 400, 100), (e) => e.name === 'AbortError');
  s.closeAllConnections?.(); s.close();
});

test('fallback model: primary 503 → alt URL answers immediately', async () => {
  const hits = [];
  const s = await server((req, res) => { hits.push(req.url); if (req.url === '/primary') { res.statusCode = 503; res.end('{}'); } else { res.end('{"from":"fallback"}'); } });
  const base = `http://127.0.0.1:${s.address().port}`;
  const t0 = Date.now();
  const r = await hedgedPost(`${base}/primary`, {}, '{}', 5000, 3000, `${base}/fallback`);
  assert.equal(r.status, 200); assert.match(r.text, /fallback/); assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(hits, ['/primary', '/fallback']); s.close();
});

test('fallback model: primary slow → hedge goes to the alt URL and wins', async () => {
  const s = await server((req, res) => { setTimeout(() => res.end(req.url === '/primary' ? '{"from":"primary"}' : '{"from":"fallback"}'), req.url === '/primary' ? 3000 : 10); });
  const base = `http://127.0.0.1:${s.address().port}`;
  const r = await hedgedPost(`${base}/primary`, {}, '{}', 8000, 300, `${base}/fallback`);
  assert.match(r.text, /fallback/); s.closeAllConnections?.(); s.close();
});
