import { lookup as defaultLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export class RemoteImageError extends Error {
  constructor(message, code = 'INVALID_IMAGE_URL') { super(message); this.name = 'MediaError'; this.code = code; }
}

export function publicAddress(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && [0, 2].includes(c))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(normalized) === 6) {
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
    if (mapped) {
      const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
      return publicAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
    }
    return /^[23]/.test(normalized) && !normalized.startsWith('2001:db8:');
  }
  return false;
}

/** Validate each request and redirect target before downloading a public image. */
export function publicImageUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new RemoteImageError('图片地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new RemoteImageError('图片仅支持 HTTP/HTTPS 地址，不允许读取本地文件。');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(hostname)) {
    if (!publicAddress(hostname)) throw new RemoteImageError('图片地址不能指向本机、内网或元数据服务。', 'PRIVATE_IMAGE_URL');
  } else if (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(hostname)) {
    throw new RemoteImageError('图片地址不能指向本机或内网服务。', 'PRIVATE_IMAGE_URL');
  }
  return url;
}

async function publicDns(url, { lookup, signal }) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
  let onAbort;
  const cancellation = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason || new DOMException('图片下载已取消。', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    signal?.throwIfAborted();
    const result = await Promise.race([lookup(hostname, { all: true, verbatim: true }), cancellation]);
    const addresses = Array.isArray(result) ? result : [result];
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) {
      throw new RemoteImageError('图片域名解析到了内网或受限地址。', 'PRIVATE_IMAGE_URL');
    }
    return addresses;
  } catch (error) {
    if (error instanceof RemoteImageError || signal?.aborted) throw error;
    throw new RemoteImageError('无法解析图片域名。', 'IMAGE_FETCH_FAILED');
  } finally { signal?.removeEventListener('abort', onAbort); }
}

/** Keep the checked IPs for the connection; DNS cannot change between check and fetch. */
export function openPinnedImage(url, addresses, { signal, requestImpl } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const request = (requestImpl || (url.protocol === 'https:' ? https.request : http.request))(url, {
      method: 'GET', signal,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }
    }, response => {
      const headers = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value || '')]));
      try {
        if ([204, 205, 304].includes(response.statusCode)) {
          response.resume(); resolve(new Response(null, { status: response.statusCode, headers }));
        } else resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers }));
      } catch {
        response.destroy(); reject(new RemoteImageError('图片服务器响应格式无效。', 'IMAGE_FETCH_FAILED'));
      }
    });
    request.once('error', error => {
      if (signal?.aborted) reject(signal.reason || error);
      else reject(new RemoteImageError('下载图片的连接失败。', 'IMAGE_FETCH_FAILED'));
    });
    request.end();
  });
}

export async function fetchPublicImage(input, { fetchImpl = fetch, signal, lookup = defaultLookup, requestImpl, maxBytes = 10 * 1024 * 1024 } = {}) {
  let url = publicImageUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal?.throwIfAborted();
    const addresses = await publicDns(url, { lookup, signal });
    const response = fetchImpl === fetch ? await openPinnedImage(url, addresses, { signal, requestImpl }) : await fetchImpl(url, { signal, redirect: 'manual' });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || redirects === 5) throw new RemoteImageError('图片跳转次数过多或缺少目标地址。', 'IMAGE_FETCH_FAILED');
      url = publicImageUrl(new URL(location, url));
      continue;
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new RemoteImageError('下载图片失败。', 'IMAGE_FETCH_FAILED'); }
    const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
      await response.body?.cancel().catch(() => {});
      throw new RemoteImageError('远程资源不是支持的图片。', 'INVALID_IMAGE');
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new RemoteImageError('图片超过大小限制。', 'IMAGE_TOO_LARGE');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new RemoteImageError('图片超过大小限制。', 'IMAGE_TOO_LARGE');
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), mime };
  }
}
