import { parseNarinfo, serializeNarinfo, fingerprint } from './narinfo.js';
import { signFingerprint, type SigningKey } from './sign.js';
import { verifyToken } from './auth.js';
import { r2FromBinding, type R2Like } from './r2.js';

export interface Env {
  CACHE_BUCKET: R2Bucket;
  SIGNING_PRIVATE_KEY: string; // Nix-format ed25519 secret (name:base64)
  JWT_ROOT_SECRET: string;     // base64
  CACHE_NAME: string;
  STORE_DIR: string;
}

function parseSigningKey(secret: string): SigningKey {
  // SIGNING_PRIVATE_KEY format: "<name>:<base64-of-64-bytes>" (matches what
  // `nix-store --generate-binary-cache-key` writes to a file).
  const idx = secret.indexOf(':');
  if (idx < 0) throw new Error('SIGNING_PRIVATE_KEY must be "<name>:<base64>"');
  const name = secret.slice(0, idx);
  const privateKeyBase64 = secret.slice(idx + 1);
  // Public key is the second 32 bytes of the 64-byte private value.
  const raw = atob(privateKeyBase64);
  if (raw.length !== 64) throw new Error(`SIGNING_PRIVATE_KEY must decode to 64 bytes, got ${raw.length}`);
  let pub = '';
  for (let i = 32; i < 64; i++) pub += raw[i];
  const publicKeyBase64 = btoa(pub);
  return { name, privateKeyBase64, publicKeyBase64 };
}

async function requireScope(req: Request, env: Env, want: 'push' | 'pull'): Promise<Response | null> {
  const auth = req.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  const token = auth.slice('Bearer '.length).trim();
  const secret = Uint8Array.from(atob(env.JWT_ROOT_SECRET), (c) => c.charCodeAt(0));
  try {
    const payload = await verifyToken(token, secret);
    if (payload.scope !== want) {
      return new Response(JSON.stringify({ error: 'scope mismatch' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    return null;
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
}

async function handleGetCacheInfo(_req: Request, r2: R2Like): Promise<Response> {
  const obj = await r2.get('nix-cache-info');
  if (!obj) return new Response('nix-cache-info missing — run setup.mjs', { status: 500 });
  return new Response(obj.body, {
    status: 200,
    headers: { 'content-type': 'text/x-nix-cache-info' },
  });
}

async function handleGetNarinfo(hash: string, r2: R2Like): Promise<Response> {
  const obj = await r2.get(`${hash}.narinfo`);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    status: 200,
    headers: { 'content-type': 'text/x-nix-narinfo' },
  });
}

async function handleGetNar(filehash: string, ext: string, r2: R2Like): Promise<Response> {
  const obj = await r2.get(`nar/${filehash}.nar.${ext}`);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
}

async function handlePutNarinfo(
  hash: string,
  req: Request,
  env: Env,
  r2: R2Like,
): Promise<Response> {
  const guard = await requireScope(req, env, 'push');
  if (guard) return guard;

  const text = await req.text();
  let narinfo;
  try {
    narinfo = parseNarinfo(text);
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const key = parseSigningKey(env.SIGNING_PRIVATE_KEY);
  const fp = fingerprint(narinfo, env.STORE_DIR);
  const sig = await signFingerprint(fp, key);

  const signed = { ...narinfo, sig };
  await r2.put(`${hash}.narinfo`, serializeNarinfo(signed));
  return new Response(JSON.stringify({ ok: true, hash }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function handlePutNar(
  filehash: string,
  ext: string,
  req: Request,
  env: Env,
  r2: R2Like,
): Promise<Response> {
  const guard = await requireScope(req, env, 'push');
  if (guard) return guard;
  if (req.body === null) return new Response('empty body', { status: 400 });
  await r2.put(`nar/${filehash}.nar.${ext}`, req.body);
  return new Response(JSON.stringify({ ok: true, filehash }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const NARINFO_PATH = /^\/([0-9a-z]+)\.narinfo$/;
const NAR_PATH = /^\/nar\/([0-9a-z]+)\.nar\.([a-z0-9]+)$/;

// Exported so tests can drive the worker with an in-memory R2Like fake
// without going through the Workers binding adapter.
export async function handleRequest(req: Request, env: Env, r2: R2Like): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/nix-cache-info' && req.method === 'GET') {
    return handleGetCacheInfo(req, r2);
  }
  const narinfoMatch = NARINFO_PATH.exec(url.pathname);
  if (narinfoMatch) {
    const hash = narinfoMatch[1]!;
    if (req.method === 'GET') return handleGetNarinfo(hash, r2);
    if (req.method === 'PUT') return handlePutNarinfo(hash, req, env, r2);
  }
  const narMatch = NAR_PATH.exec(url.pathname);
  if (narMatch) {
    const filehash = narMatch[1]!;
    const ext = narMatch[2]!;
    if (req.method === 'GET') return handleGetNar(filehash, ext, r2);
    if (req.method === 'PUT') return handlePutNar(filehash, ext, req, env, r2);
  }
  return new Response('not found', { status: 404 });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env, r2FromBinding(env.CACHE_BUCKET));
  },
};
