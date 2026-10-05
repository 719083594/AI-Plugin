import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchPublicImage } from './remote.mjs';

const REF = /^img_[a-f0-9]{32}$/;
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;
const DEFAULT_LIMIT = 10 * 1024 * 1024;

export class MediaError extends Error {
  constructor(message, code = 'MEDIA_ERROR') { super(message); this.name = 'MediaError'; this.code = code; }
}

function decodeData(value, mime) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(value);
  const base64 = (match ? match[2] : value).replace(/\s/g, '');
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new MediaError('图片 base64 数据无效。', 'INVALID_IMAGE');
  }
  return { buffer: Buffer.from(base64, 'base64'), mime: match?.[1] || mime };
}

function detectedMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function storedMetadata(ref, options, mime, size, now, ttlMs) {
  return { ref, mime, size, createdAt: now, expiresAt: ttlMs === 0 ? Number.MAX_SAFE_INTEGER : now + ttlMs,
    ...(options.source ? { source: String(options.source).slice(0, 80) } : {}),
    ...(options.origin ? { origin: String(options.origin).slice(0, 80) } : {}),
    ...(options.userId ? { userId: String(options.userId) } : {}),
    ...(options.groupId ? { groupId: String(options.groupId) } : {}) };
}

/** Owned image cache. Only generated refs can resolve to files in its directory. */
export class ImageStore {
  constructor({ directory, ttlMs = 7 * 86400000, maxBytes = DEFAULT_LIMIT, fetchImpl = fetch, lookup, now = Date.now } = {}) {
    if (!directory) throw new MediaError('必须指定图片缓存目录。', 'INVALID_CONFIG');
    if (!Number.isFinite(ttlMs) || ttlMs < 0 || !Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_LIMIT) {
      throw new MediaError('图片缓存期限或大小配置无效，最大允许 10MB。', 'INVALID_CONFIG');
    }
    this.directory = path.resolve(directory);
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
    this.now = now;
    this.metadata = new Map();
    this.loading = null;
  }

  async init() {
    this.loading ??= this.#load();
    await this.loading;
    return this;
  }

  async #load() {
    await fs.mkdir(this.directory, { recursive: true });
    const root = await fs.lstat(this.directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new MediaError('图片缓存目录不能是符号链接。', 'INVALID_CONFIG');
    for (const filename of await fs.readdir(this.directory)) {
      if (!filename.endsWith('.json') || !REF.test(filename.slice(0, -5))) continue;
      try {
        const file = path.join(this.directory, filename);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) continue;
        const info = JSON.parse(await fs.readFile(file, 'utf8'));
        if (info.ref !== filename.slice(0, -5) || !IMAGE_MIME.test(info.mime) || !Number.isFinite(info.expiresAt)
          || !Number.isFinite(info.size) || info.size > this.maxBytes) continue;
        this.metadata.set(info.ref, info);
      } catch { /* An incomplete/corrupt cache entry is unavailable, never treated as an image. */ }
    }
  }

  async #readInput(input, options) {
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) return { buffer: Buffer.from(input), mime: options.mime };
    if (typeof input === 'object' && input) {
      if (input.data) return decodeData(input.data, input.mime || options.mime);
      if (input.url) return this.#readInput(input.url, { ...options, mime: input.mime || options.mime });
      throw new MediaError('图片输入必须提供 url 或 data。', 'INVALID_IMAGE');
    }
    if (typeof input !== 'string') throw new MediaError('图片输入无效。', 'INVALID_IMAGE');
    if (input.startsWith('data:')) return decodeData(input, options.mime);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    return fetchPublicImage(input, { fetchImpl: this.fetchImpl, lookup: this.lookup, signal, maxBytes: this.maxBytes });
  }

  async save(input, options = {}) {
    await this.init();
    options.signal?.throwIfAborted();
    const { buffer, mime: claimedMime } = await this.#readInput(input, options);
    if (!buffer.length || buffer.length > this.maxBytes) throw new MediaError('图片为空或超过缓存大小限制。', 'IMAGE_TOO_LARGE');
    const mime = detectedMime(buffer);
    if (!mime || (claimedMime && claimedMime !== mime)) throw new MediaError('图片内容与格式不匹配。', 'INVALID_IMAGE');
    const ttlMs = options.ttlMs ?? this.ttlMs;
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new MediaError('图片缓存期限无效。', 'INVALID_CONFIG');
    options.signal?.throwIfAborted();
    const ref = `img_${randomUUID().replaceAll('-', '')}`;
    const info = storedMetadata(ref, options, mime, buffer.length, this.now(), ttlMs);
    await fs.writeFile(path.join(this.directory, `${ref}.bin`), buffer, { flag: 'wx', mode: 0o600 });
    try { await fs.writeFile(path.join(this.directory, `${ref}.json`), JSON.stringify(info), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await fs.unlink(path.join(this.directory, `${ref}.bin`)).catch(() => {}); throw error; }
    this.metadata.set(ref, info);
    return ref;
  }

  async has(ref) {
    await this.init();
    return REF.test(ref) && this.metadata.has(ref) && this.metadata.get(ref).expiresAt > this.now();
  }

  async resolve(ref, { signal } = {}) {
    await this.init();
    signal?.throwIfAborted();
    if (!REF.test(ref) || !this.metadata.has(ref)) throw new MediaError('图片引用不存在。', 'IMAGE_NOT_FOUND');
    const info = this.metadata.get(ref);
    if (info.expiresAt <= this.now()) throw new MediaError('图片引用已过期。', 'IMAGE_EXPIRED');
    const filename = path.join(this.directory, `${ref}.bin`);
    let buffer;
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes) throw new MediaError('图片缓存文件无效。', 'INVALID_IMAGE');
      buffer = await fs.readFile(filename);
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError('图片缓存文件不存在。', 'IMAGE_NOT_FOUND');
    }
    if (detectedMime(buffer) !== info.mime || buffer.length !== info.size) throw new MediaError('图片缓存文件已损坏。', 'INVALID_IMAGE');
    signal?.throwIfAborted();
    return { ...info, type: 'image', data: buffer.toString('base64') };
  }

  async cleanup() {
    await this.init();
    let removed = 0;
    for (const [ref, info] of this.metadata) {
      if (info.expiresAt > this.now()) continue;
      for (const extension of ['bin', 'json']) await fs.unlink(path.join(this.directory, `${ref}.${extension}`)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      this.metadata.delete(ref);
      removed++;
    }
    return removed;
  }
}

export function contextImages(context = {}) {
  const messageImages = message => (message?.content ?? []).filter(part => part.type === 'image');
  return [...(context.images ?? []), ...messageImages(context.message), ...messageImages(context.reply),
    ...(context.messages ?? []).flatMap(messageImages).reverse()];
}
