import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImageStore } from '../src/media/index.mjs';
import { ToolRegistry, createBuiltinTools } from '../src/tools/index.mjs';
import { publicImageUrl, publicAddress, fetchPublicImage } from '../src/media/remote.mjs';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S2sAAAAASUVORK5CYII=';
const signal = () => new AbortController().signal;
const context = extra => ({ userId: '300000001', groupId: '10001', signal: signal(), ...extra });
async function cache(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-plugin-media-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('ai-plugin-media-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return new ImageStore({ directory, lookup: async () => [{ address: '93.184.216.34', family: 4 }], ...options });
}

test('images survive restart with scoped metadata and exact mime/data', async t => {
  const store = await cache(t);
  const ref = await store.save({ data: png, mime: 'image/png' }, { userId: '1', groupId: '2', signal: signal() });
  const reopened = new ImageStore({ directory: store.directory });
  const image = await reopened.resolve(ref);
  assert.equal(image.data, png);
  assert.equal(image.mime, 'image/png');
  assert.equal(image.userId, '1');
  assert.equal(image.groupId, '2');
  assert.equal(await reopened.has(ref), true);
});

test('image TTL cleanup deletes only owned expired refs and metadata', async t => {
  let now = 100;
  const store = await cache(t, { now: () => now, ttlMs: 50 });
  const ref = await store.save(Buffer.from(png, 'base64'));
  await fs.writeFile(path.join(store.directory, 'keep.txt'), 'unrelated');
  now = 151;
  await assert.rejects(store.resolve(ref), { code: 'IMAGE_EXPIRED' });
  assert.equal(await store.cleanup(), 1);
  assert.deepEqual(await fs.readdir(store.directory), ['keep.txt']);
});

test('file URLs, arbitrary paths, forged refs and mime mismatch cannot read local files', async t => {
  const store = await cache(t);
  await assert.rejects(store.save('file:///etc/passwd'), { code: 'INVALID_IMAGE_URL' });
  await assert.rejects(store.save('C:\\Users\\private.png'), { code: 'INVALID_IMAGE_URL' });
  await assert.rejects(store.resolve('../../outside'), { code: 'IMAGE_NOT_FOUND' });
  await assert.rejects(store.save({ data: png, mime: 'image/jpeg' }), { code: 'INVALID_IMAGE' });
  await assert.rejects(store.save({ data: 'bm90IGFuIGltYWdl', mime: 'image/png' }), { code: 'INVALID_IMAGE' });
});

test('remote image size, format and host cancellation are enforced', async t => {
  const store = await cache(t, { maxBytes: 64, fetchImpl: async () => new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } }) });
  await assert.rejects(store.save('https://images.invalid/photo.png'), { code: 'IMAGE_TOO_LARGE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.save(Buffer.from(png, 'base64'), { signal: controller.signal }), { name: 'AbortError' });
});

test('registry lists descriptions only and validates required arguments/permission/signal', async () => {
  const registry = new ToolRegistry([{ name: 'admin', description: '管理', requiresMaster: true,
    inputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1 } }, required: ['n'], additionalProperties: false }, execute: args => args.n }]);
  assert.equal(registry.get('admin').execute, undefined);
  assert.deepEqual(registry.list({ names: ['missing', 'admin'] }).map(item => item.name), ['admin']);
  await assert.rejects(registry.execute('admin', { n: 1 }, {}), { code: 'SIGNAL_REQUIRED' });
  await assert.rejects(registry.execute('admin', { n: 1 }, context()), { code: 'FORBIDDEN' });
  await assert.rejects(registry.execute('admin', { n: 0 }, context({ isMaster: true })), { code: 'INVALID_TOOL_ARGUMENTS' });
  await assert.rejects(registry.execute('admin', '{broken', context({ isMaster: true })), { code: 'INVALID_TOOL_ARGUMENTS' });
  assert.equal(await registry.execute('admin', '{"n":2}', context({ isMaster: true })), 2);
});

test('five builtin names and disabled dependencies remain explicit', async () => {
  const registry = new ToolRegistry(createBuiltinTools());
  assert.deepEqual(registry.list().map(item => item.name), ['web_search', 'ask_about_image', 'look_at_image', 'resolve_image_ref', 'GetQQAvatar']);
  await assert.rejects(registry.execute('web_search', { query: '完整问题' }, context()), { code: 'TOOL_UNCONFIGURED' });
  await assert.rejects(registry.execute('ask_about_image', {}, context()), { code: 'TOOL_UNCONFIGURED' });
});

test('search receives unchanged complete query and signal, retains provenance', async () => {
  let captured;
  const registry = new ToolRegistry(createBuiltinTools({ search: async request => {
    captured = request; return { ok: true, query: request.query, engine: '360', searchUrl: 'https://www.so.com/s?q=完整', provenance: { originalQuery: request.query }, results: [{ title: '资料', url: 'https://source.invalid/' }] };
  } }));
  const ctx = context();
  const result = await registry.execute('web_search', { query: '中国有哪些种类的猫' }, ctx);
  assert.equal(captured.query, '中国有哪些种类的猫');
  assert.equal(captured.signal, ctx.signal);
  assert.equal(result.engine, '360');
  assert.equal(result.provenance.originalQuery, captured.query);
  assert.equal(result.delivered, false);
});

test('search image success sends once and false receipts report failure', async t => {
  const imageStore = await cache(t);
  const registry = new ToolRegistry(createBuiltinTools({ imageStore, search: async () => ({ ok: true, query: '问题', results: [{ title: '资料', url: 'https://source.invalid/' }], format: 'image', imageBase64: png, imageMime: 'image/png' }) }));
  let sends = 0;
  const result = await registry.execute('web_search', { query: '问题', type: 'image' }, context({ send: async contents => { sends++; assert.equal(contents[0].mime, 'image/png'); return { delivered: true }; } }));
  assert.equal(sends, 1);
  assert.equal(result.delivered, true);
  assert.equal(result.imageBase64, undefined);
  assert.equal(result.imageRefs.length, 1);
  await assert.rejects(registry.execute('web_search', { query: '问题', type: 'image' }, context({ send: async () => false })), { code: 'SEND_FAILED' });
});

test('JPEG search format is preserved when the nested API returns imageType only', async t => {
  const imageStore = await cache(t);
  // This signature fixture checks the MIME handoff; rendering is owned by search.
  const data = Buffer.from([255,216,255,224,0,16]).toString('base64');
  const registry = new ToolRegistry(createBuiltinTools({ imageStore, search: async () => ({ok:true, results:[{title:'资料',url:'https://source.invalid/'}], format:'image', imageBase64:data, imageType:'jpeg'}) }));
  const result = await registry.execute('web_search', {query:'问题',type:'image'}, context({send: async contents => {
    assert.equal(contents[0].mime, 'image/jpeg'); assert.equal(contents[0].data, data); return true;
  }}));
  assert.equal((await imageStore.resolve(result.imageRefs[0])).mime, 'image/jpeg');
});

test('search errors and empty results never masquerade as successful answer', async () => {
  const failed = new ToolRegistry(createBuiltinTools({ search: async () => ({ ok: false }) }));
  const empty = new ToolRegistry(createBuiltinTools({ search: async () => ({ ok: true, results: [] }) }));
  await assert.rejects(failed.execute('web_search', { query: '问题' }, context()), { code: 'SEARCH_FAILED' });
  await assert.rejects(empty.execute('web_search', { query: '问题' }, context()), { code: 'SEARCH_EMPTY' });
});

test('image vision uses real cache data and empty model output fails', async t => {
  const imageStore = await cache(t);
  const ref = await imageStore.save(Buffer.from(png, 'base64'), { groupId: '10001' });
  let captured;
  const registry = new ToolRegistry(createBuiltinTools({ imageStore, vision: async request => { captured = request; return { contents: [{ type: 'text', text: '真实图片说明' }] }; } }));
  const ctx = context({ images: [{ ref }] });
  const answer = await registry.execute('ask_about_image', { question: '图上是什么' }, ctx);
  assert.equal(captured.images[0].data, png);
  assert.equal(captured.signal, ctx.signal);
  assert.equal(answer.answer, '真实图片说明');
  const empty = new ToolRegistry(createBuiltinTools({ imageStore, vision: async () => '' }));
  await assert.rejects(empty.execute('look_at_image', { ref }, ctx), { code: 'EMPTY_VISION_RESPONSE' });
});

test('cross-group and private-user refs are denied and resolver omits large data by default', async t => {
  const imageStore = await cache(t);
  const other = await imageStore.save(Buffer.from(png, 'base64'), { groupId: '99999' });
  const mine = await imageStore.save(Buffer.from(png, 'base64'), { groupId: '10001' });
  const privateRef = await imageStore.save(Buffer.from(png, 'base64'), { userId: 'different-user' });
  const registry = new ToolRegistry(createBuiltinTools({ imageStore }));
  await assert.rejects(registry.execute('resolve_image_ref', { ref: other }, context()), { code: 'FORBIDDEN' });
  await assert.rejects(registry.execute('resolve_image_ref', { ref: privateRef }, context()), { code: 'FORBIDDEN' });
  const result = await registry.execute('resolve_image_ref', { ref: mine }, context());
  assert.equal(result.dataUrl, undefined);
  const embedded = await registry.execute('resolve_image_ref', { ref: mine, includeData: true }, context());
  assert.equal(embedded.dataUrl, `data:image/png;base64,${png}`);
});

test('QQ avatar uses host injection and only current explicit targets', async t => {
  const imageStore = await cache(t);
  const registry = new ToolRegistry(createBuiltinTools({ imageStore }));
  const requested = [];
  const result = await registry.execute('GetQQAvatar', { includeBot: true, includeAtUsers: true }, context({ botId: '123456', mentions: ['234567'], host: { getAvatar: async qq => { requested.push(qq); return Buffer.from(png, 'base64'); } } }));
  assert.deepEqual(requested, ['123456', '234567']);
  assert.equal(result.delivered, false);
  assert.equal(result.images.length, 2);
  await assert.rejects(registry.execute('GetQQAvatar', {}, context()), { code: 'QQ_REQUIRED' });
  await assert.rejects(registry.execute('GetQQAvatar', { qqs: ['file:///private'] }, context()), { code: 'INVALID_QQ' });
});

test('registry cancellation releases a hung extension even when it ignores the signal', async () => {
  const registry = new ToolRegistry([{ name: 'hung', description: '模拟挂起', inputSchema: { type: 'object' }, execute: async () => new Promise(() => {}) }]);
  const controller = new AbortController();
  const pending = registry.execute('hung', {}, context({ signal: controller.signal }));
  controller.abort(new Error('deadline reached'));
  await assert.rejects(pending, /deadline reached/);
});

test('tampered metadata cannot resolve external filenames and corrupted cache data is rejected', async t => {
  const store = await cache(t);
  const ref = await store.save(Buffer.from(png, 'base64'));
  const metadata = JSON.parse(await fs.readFile(path.join(store.directory, `${ref}.json`), 'utf8'));
  metadata.filename = '../../outside';
  await fs.writeFile(path.join(store.directory, `${ref}.json`), JSON.stringify(metadata));
  const restarted = new ImageStore({ directory: store.directory });
  assert.equal((await restarted.resolve(ref)).data, png);
  await fs.writeFile(path.join(store.directory, `${ref}.bin`), 'tampered');
  await assert.rejects(restarted.resolve(ref), { code: 'INVALID_IMAGE' });
});

test('zero TTL means permanent cache and survives restart and cleanup', async t => {
  let now = 100;
  const store = await cache(t, { ttlMs: 0, now: () => now });
  const ref = await store.save(Buffer.from(png, 'base64'));
  const overridden = await store.save(Buffer.from(png, 'base64'), { ttlMs: 0 });
  now = 1000000000000;
  const reopened = new ImageStore({ directory: store.directory, ttlMs: 0, now: () => now });
  assert.equal((await reopened.resolve(ref)).expiresAt, Number.MAX_SAFE_INTEGER);
  assert.equal(await reopened.cleanup(), 0);
  assert.equal(await reopened.has(overridden), true);
});

test('image network policy rejects private/metadata/encoded IPs and DNS-to-private', async t => {
  for (const url of ['http://localhost/p.png', 'http://127.0.0.1/p.png', 'http://2130706433/p.png', 'http://0x7f000001/p.png',
    'http://169.254.169.254/latest', 'http://10.0.0.1/p.png', 'http://[::1]/p.png', 'http://[::ffff:127.0.0.1]/p.png', 'http://metadata.google.internal/p.png']) {
    assert.throws(() => publicImageUrl(url), { code: 'PRIVATE_IMAGE_URL' });
  }
  let fetched = false;
  const store = await cache(t, { lookup: async () => [{ address: '169.254.169.254', family: 4 }], fetchImpl: async () => { fetched = true; } });
  await assert.rejects(store.save('https://public-looking.invalid/p.png'), { code: 'PRIVATE_IMAGE_URL' });
  assert.equal(fetched, false);
});

test('every redirect is validated while public CDN redirects remain usable', async t => {
  let calls = 0;
  const blocked = await cache(t, { fetchImpl: async () => { calls++; return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/private' } }); } });
  await assert.rejects(blocked.save('https://cdn.invalid/image'), { code: 'PRIVATE_IMAGE_URL' });
  assert.equal(calls, 1);
  let redirects = 0;
  const publicStore = await cache(t, { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    if (redirects++ === 0) return new Response('', { status: 302, headers: { location: 'https://other-cdn.invalid/p.png' } });
    return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
  } });
  const ref = await publicStore.save('https://cdn.invalid/image');
  assert.equal((await publicStore.resolve(ref)).mime, 'image/png');
});

test('production transport pins DNS-checked public addresses for the actual connection', async () => {
  let lookupCount = 0;
  let connectedAddress;
  const image = await fetchPublicImage('https://cdn.invalid/p.png', {
    lookup: async () => { lookupCount++; return [{ address: '93.184.216.34', family: 4 }]; },
    requestImpl: (_url, options, onResponse) => {
      options.lookup('cdn.invalid', {}, (_error, address, family) => { connectedAddress = { address, family }; });
      const request = new EventEmitter();
      request.end = () => {
        const response = new PassThrough(); response.statusCode = 200; response.headers = { 'content-type': 'image/png' };
        onResponse(response); response.end(Buffer.from(png, 'base64'));
      };
      return request;
    }
  });
  assert.equal(lookupCount, 1);
  assert.deepEqual(connectedAddress, { address: '93.184.216.34', family: 4 });
  assert.equal(image.mime, 'image/png');
  assert.equal(image.buffer.toString('base64'), png);
});

test('public CDN address ranges are not mistaken for documentation/private addresses', () => {
  assert.equal(publicAddress('192.0.78.24'), true);
  assert.equal(publicAddress('203.0.10.1'), true);
  assert.equal(publicAddress('198.51.10.1'), true);
  assert.equal(publicAddress('192.0.2.1'), false);
  assert.equal(publicAddress('203.0.113.1'), false);
});

test('empty HTTP image response fails normally without throwing from the request callback', async () => {
  await assert.rejects(fetchPublicImage('https://cdn.invalid/image', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl: (_url, _options, onResponse) => {
      const request = new EventEmitter(); request.end = () => {
        const response = new PassThrough(); response.statusCode = 204; response.headers = {};
        onResponse(response); response.end();
      }; return request;
    }
  }), { code: 'INVALID_IMAGE' });
});
