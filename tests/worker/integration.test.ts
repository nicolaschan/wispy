import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { handleRequest, type Env } from '../../worker/src/index.js';
import { issueToken } from '../../worker/src/auth.js';
import { parseNarinfo } from '../../worker/src/narinfo.js';
import type { R2Like } from '../../worker/src/r2.js';

// Drive the Worker handler with an in-memory R2Like fake. Exercises the
// full path (router → auth → narinfo parse → ed25519 sign → R2 put → GET
// → cross-verify with node:crypto) without spawning wrangler dev.

function makeFakeR2(): R2Like & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  async function readStream(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const reader = s.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  return {
    _store: store,
    async get(key) {
      const bytes = store.get(key);
      if (bytes === undefined) return null;
      return { body: streamOf(bytes), httpEtag: '"fake"' };
    },
    async head(key) {
      const bytes = store.get(key);
      if (bytes === undefined) return null;
      return { httpEtag: '"fake"' };
    },
    async put(key, value) {
      let bytes: Uint8Array;
      if (typeof value === 'string') {
        bytes = new TextEncoder().encode(value);
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else {
        bytes = await readStream(value);
      }
      store.set(key, bytes);
      return { key };
    },
  };
}

type Key = { name: string; privateKeyBase64: string; publicKeyBase64: string };
const key: Key = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'signing-test-key.json'), 'utf8'),
);

const SIGNING_PRIVATE_KEY = `${key.name}:${key.privateKeyBase64}`;
const JWT_ROOT_SECRET = Buffer.from('integration-test-secret-32-bytes').toString('base64');

let r2: ReturnType<typeof makeFakeR2>;
let env: Env;
let pushToken: string;

beforeAll(async () => {
  r2 = makeFakeR2();
  env = {
    CACHE_BUCKET: undefined as unknown as R2Bucket, // unused; handleRequest takes r2 directly
    SIGNING_PRIVATE_KEY,
    JWT_ROOT_SECRET,
    CACHE_NAME: 'wispy-it',
    STORE_DIR: '/nix/store',
  };
  pushToken = await issueToken(
    { scope: 'push' },
    Uint8Array.from(Buffer.from(JWT_ROOT_SECRET, 'base64')),
  );
  await r2.put('nix-cache-info', 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\n');
});

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FILEHASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const NARINFO_NO_SIG = [
  `StorePath: /nix/store/${HASH}-hello`,
  `URL: nar/${FILEHASH}.nar.zst`,
  'Compression: zstd',
  'FileHash: sha256:abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop',
  'FileSize: 1234',
  'NarHash: sha256:1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMnop',
  'NarSize: 5678',
  'References: ',
  '',
].join('\n');

function call(req: Request): Promise<Response> {
  return handleRequest(req, env, r2);
}

function ed25519PubFromRaw(raw: Buffer): ReturnType<typeof createPublicKey> {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
}

describe('worker handleRequest', () => {
  it('serves nix-cache-info', async () => {
    const r = await call(new Request('https://x/nix-cache-info'));
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/^StoreDir: \/nix\/store/);
  });

  it('rejects PUT narinfo without a bearer token', async () => {
    const r = await call(
      new Request(`https://x/${HASH}.narinfo`, { method: 'PUT', body: NARINFO_NO_SIG }),
    );
    expect(r.status).toBe(401);
  });

  it('rejects PUT narinfo with a malformed bearer', async () => {
    const r = await call(
      new Request(`https://x/${HASH}.narinfo`, {
        method: 'PUT',
        headers: { authorization: 'Bearer not.a.jwt' },
        body: NARINFO_NO_SIG,
      }),
    );
    expect(r.status).toBe(401);
  });

  it('signs the narinfo on PUT and the signature verifies on GET', async () => {
    const put = await call(
      new Request(`https://x/${HASH}.narinfo`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${pushToken}` },
        body: NARINFO_NO_SIG,
      }),
    );
    expect(put.status).toBe(200);

    const get = await call(new Request(`https://x/${HASH}.narinfo`));
    expect(get.status).toBe(200);
    const text = await get.text();

    const parsed = parseNarinfo(text);
    expect(parsed.sig).toBeDefined();
    expect(parsed.sig!.startsWith(`${key.name}:`)).toBe(true);

    // Cross-verify signature with the matching pubkey.
    const [, base64] = parsed.sig!.split(':');
    const sigBytes = Buffer.from(base64!, 'base64');
    const pubKey = ed25519PubFromRaw(Buffer.from(key.publicKeyBase64, 'base64'));
    const fp = `1;${parsed.storePath};${parsed.narHash};${parsed.narSize};`;
    const ok = verify(null, Buffer.from(fp, 'utf8'), pubKey, sigBytes);
    expect(ok).toBe(true);
  });

  it('returns 404 for an unknown narinfo', async () => {
    const r = await call(
      new Request('https://x/cccccccccccccccccccccccccccccccc.narinfo'),
    );
    expect(r.status).toBe(404);
  });

  it('streams a NAR put through to R2 and serves it back', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const put = await call(
      new Request(`https://x/nar/${FILEHASH}.nar.zst`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${pushToken}` },
        body,
      }),
    );
    expect(put.status).toBe(200);

    const get = await call(new Request(`https://x/nar/${FILEHASH}.nar.zst`));
    expect(get.status).toBe(200);
    const got = new Uint8Array(await get.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(body));
  });

  it('rejects PUT NAR without auth', async () => {
    const r = await call(
      new Request(`https://x/nar/${FILEHASH}.nar.zst`, {
        method: 'PUT',
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(r.status).toBe(401);
  });

  it('returns 404 for unknown paths', async () => {
    const r = await call(new Request('https://x/some-other-path'));
    expect(r.status).toBe(404);
  });
});
