import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import worker, { type Env } from '../../worker/src/index.js';
import { issueToken } from '../../worker/src/auth.js';
import { parseNarinfo } from '../../worker/src/narinfo.js';

// Drive the Worker's `fetch` handler directly with an in-memory R2 fake.
// This exercises the same code path that runs in production (router →
// auth → narinfo parse → ed25519 sign → R2 put) without the cost or
// flakiness of spawning `wrangler dev`.

class FakeR2 implements R2Bucket {
  private store = new Map<string, Uint8Array>();

  async get(key: string): Promise<R2ObjectBody | null> {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return makeR2ObjectBody(key, v);
  }
  async head(key: string): Promise<R2Object | null> {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return makeR2ObjectBody(key, v);
  }
  async put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | string | Blob | null,
  ): Promise<R2Object> {
    let bytes: Uint8Array;
    if (value === null) {
      bytes = new Uint8Array();
    } else if (typeof value === 'string') {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (value instanceof ReadableStream) {
      const chunks: Uint8Array[] = [];
      const reader = value.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (chunk) chunks.push(chunk);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.length;
      }
    } else {
      bytes = new Uint8Array(await value.arrayBuffer());
    }
    this.store.set(key, bytes);
    return makeR2ObjectBody(key, bytes);
  }
  async delete(): Promise<void> {
    throw new Error('not implemented');
  }
  async list(): Promise<R2Objects> {
    throw new Error('not implemented');
  }
  async createMultipartUpload(): Promise<R2MultipartUpload> {
    throw new Error('not implemented');
  }
  async resumeMultipartUpload(): Promise<R2MultipartUpload> {
    throw new Error('not implemented');
  }
}

function makeR2ObjectBody(key: string, bytes: Uint8Array): R2ObjectBody {
  return {
    key,
    version: 'v1',
    size: bytes.length,
    etag: 'fake-etag',
    httpEtag: '"fake-etag"',
    checksums: {} as R2Checksums,
    uploaded: new Date(),
    httpMetadata: {} as R2HTTPMetadata,
    customMetadata: {},
    storageClass: 'Standard',
    range: undefined,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    bodyUsed: false,
    async arrayBuffer(): Promise<ArrayBuffer> {
      // Detach to a fresh ArrayBuffer to satisfy the strict ArrayBuffer type.
      const out = new Uint8Array(bytes.length);
      out.set(bytes);
      return out.buffer;
    },
    async text(): Promise<string> {
      return new TextDecoder().decode(bytes);
    },
    async json<T>(): Promise<T> {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    },
    async blob(): Promise<Blob> {
      return new Blob([bytes as unknown as ArrayBuffer]);
    },
    writeHttpMetadata(): void {},
  };
}

type Key = { name: string; privateKeyBase64: string; publicKeyBase64: string };
const key: Key = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'signing-test-key.json'), 'utf8'),
);

const SIGNING_PRIVATE_KEY = `${key.name}:${key.privateKeyBase64}`;
// JWT secret: 32 random bytes, base64.
const JWT_ROOT_SECRET = Buffer.from(
  'integration-test-secret-32-bytes',
).toString('base64');

let env: Env;
let pushToken: string;

beforeAll(async () => {
  env = {
    CACHE_BUCKET: new FakeR2() as unknown as R2Bucket,
    SIGNING_PRIVATE_KEY,
    JWT_ROOT_SECRET,
    CACHE_NAME: 'wispy-it',
    STORE_DIR: '/nix/store',
  };
  pushToken = await issueToken(
    { scope: 'push' },
    Uint8Array.from(Buffer.from(JWT_ROOT_SECRET, 'base64')),
  );
  // Seed nix-cache-info so GET works.
  await env.CACHE_BUCKET.put(
    'nix-cache-info',
    'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\n',
  );
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

function fetchWorker(req: Request): Promise<Response> {
  return worker.fetch(req, env);
}

function ed25519PubFromRaw(raw: Buffer): ReturnType<typeof createPublicKey> {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
}

describe('worker fetch handler', () => {
  it('serves nix-cache-info', async () => {
    const r = await fetchWorker(new Request('https://x/nix-cache-info'));
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/^StoreDir: \/nix\/store/);
  });

  it('rejects PUT narinfo without a bearer token', async () => {
    const r = await fetchWorker(
      new Request(`https://x/${HASH}.narinfo`, {
        method: 'PUT',
        body: NARINFO_NO_SIG,
      }),
    );
    expect(r.status).toBe(401);
  });

  it('rejects PUT narinfo with a malformed bearer', async () => {
    const r = await fetchWorker(
      new Request(`https://x/${HASH}.narinfo`, {
        method: 'PUT',
        headers: { authorization: 'Bearer not.a.jwt' },
        body: NARINFO_NO_SIG,
      }),
    );
    expect(r.status).toBe(401);
  });

  it('signs the narinfo on PUT and the signature verifies on GET', async () => {
    const put = await fetchWorker(
      new Request(`https://x/${HASH}.narinfo`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${pushToken}` },
        body: NARINFO_NO_SIG,
      }),
    );
    expect(put.status).toBe(200);

    const get = await fetchWorker(new Request(`https://x/${HASH}.narinfo`));
    expect(get.status).toBe(200);
    const text = await get.text();

    const parsed = parseNarinfo(text);
    expect(parsed.sig).toBeDefined();
    expect(parsed.sig!.startsWith(`${key.name}:`)).toBe(true);

    // Cross-verify the signature with the matching pubkey.
    const [, base64] = parsed.sig!.split(':');
    const sigBytes = Buffer.from(base64!, 'base64');
    const pubKey = ed25519PubFromRaw(Buffer.from(key.publicKeyBase64, 'base64'));
    const fp = `1;${parsed.storePath};${parsed.narHash};${parsed.narSize};`;
    const ok = verify(null, Buffer.from(fp, 'utf8'), pubKey, sigBytes);
    expect(ok).toBe(true);
  });

  it('returns 404 for an unknown narinfo', async () => {
    const r = await fetchWorker(new Request('https://x/cccccccccccccccccccccccccccccccc.narinfo'));
    expect(r.status).toBe(404);
  });

  it('streams a NAR put through to R2 and serves it back', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const put = await fetchWorker(
      new Request(`https://x/nar/${FILEHASH}.nar.zst`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${pushToken}` },
        body,
      }),
    );
    expect(put.status).toBe(200);

    const get = await fetchWorker(new Request(`https://x/nar/${FILEHASH}.nar.zst`));
    expect(get.status).toBe(200);
    const got = new Uint8Array(await get.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(body));
  });

  it('rejects PUT NAR without auth', async () => {
    const r = await fetchWorker(
      new Request(`https://x/nar/${FILEHASH}.nar.zst`, {
        method: 'PUT',
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(r.status).toBe(401);
  });

  it('returns 404 for unknown paths', async () => {
    const r = await fetchWorker(new Request('https://x/some-other-path'));
    expect(r.status).toBe(404);
  });
});
