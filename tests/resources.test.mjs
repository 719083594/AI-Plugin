import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { superviseChild, withBudget, closeHttpServer } from './helpers/resources.mjs';

function fixture(t, source, options = {}) {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lifecycle = superviseChild(child, { label: 'cleanup regression fixture', ...options });
  t.after(() => lifecycle.stop());
  return lifecycle;
}

test('child cleanup observes close that occurred before the after hook', async t => {
  const lifecycle = fixture(t, 'process.stdout.write("READY");');
  await lifecycle.ready();
  assert.equal((await withBudget(lifecycle.closed, 3000, 'child exit')).code, 0);
  assert.equal((await withBudget(lifecycle.stop(), 1000, 'already-closed cleanup')).code, 0);
});

test('child startup failure can still be cleaned without waiting for another close event', async t => {
  const lifecycle = fixture(t, 'process.exit(3);');
  await assert.rejects(lifecycle.ready(), /exited before ready \(3\)/);
  assert.equal((await lifecycle.stop()).code, 3);
});

test('missing child executable is cleaned after the spawn error', async t => {
  const child = spawn(process.execPath + '.ai-plugin-test-missing', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lifecycle = superviseChild(child, { label: 'missing executable fixture' });
  t.after(() => lifecycle.stop());
  await assert.rejects(lifecycle.ready(), /could not start \(ENOENT\)/);
  await withBudget(lifecycle.stop(), 3000, 'failed-spawn cleanup');
});

test('child that never becomes ready is forcibly stopped within its cleanup budget', async t => {
  const lifecycle = fixture(t, 'process.stdin.resume(); setInterval(() => {}, 1000);', { graceMs: 30, killMs: 1000 });
  await assert.rejects(lifecycle.ready('READY', 100), /startup timed out/);
  assert.equal((await withBudget(lifecycle.stop(), 3000, 'forced child cleanup')).forced, true);
});

test('HTTP cleanup closes unfinished responses instead of waiting forever', async t => {
  const server = http.createServer((_request, response) => { response.writeHead(200); response.write('unfinished'); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await withBudget(new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), 3000, 'HTTP startup');
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: AbortSignal.timeout(3000) });
  const body = response.text();
  const refusedBody = assert.rejects(body);
  await closeHttpServer(server);
  await refusedBody;
  assert.equal(server.listening, false);
});
