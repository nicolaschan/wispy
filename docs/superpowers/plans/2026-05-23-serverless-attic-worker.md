# Wispy v2 (Serverless Attic) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace wispy v1 (s3-direct from CI to R2) with a Cloudflare Worker that fronts R2, owns the Nix signing key, and authenticates CI via a scoped JWT — collapsing the CI surface to one secret + one variable.

**Architecture:** Worker exposes the standard Nix HTTPS binary cache protocol. On `PUT /<hash>.narinfo`, the Worker parses the client-supplied narinfo, signs it server-side with ed25519, and writes the signed narinfo + the uploaded NAR to R2. The CI action sets up a user-level `nix.conf` (via `NIX_USER_CONF_FILES`) with the Worker as a substituter and a `post-build-hook` that runs `nix copy --to <worker-url>`. No client-side signing, no AWS creds on the runner, no systemd drop-in, no daemon restart.

**Tech Stack:** TypeScript, Cloudflare Workers, R2, ed25519 (via Node's `crypto`), HS256 JWT, vitest, wrangler. All tooling provided by `flake.nix` devShell — assume only `nix` is preinstalled.

---

## File Structure

```
wispy/
├── flake.nix                       # devShell adds wrangler, gh, jq
├── flake.lock
├── action.yml                       # Action manifest, 2 inputs
├── dist/                            # bundled action (committed)
│   ├── main/index.js
│   └── post/index.js
├── package.json                     # root deps for action + worker + scripts
├── tsconfig.json                    # base tsconfig
├── tsconfig.action.json             # for action source (Node-only)
├── worker/
│   ├── tsconfig.json                # extends root, Workers types only
│   ├── wrangler.toml                # main = "src/index.ts"
│   └── src/
│       ├── index.ts                 # router + handlers
│       ├── narinfo.ts               # parse + serialize narinfo
│       ├── sign.ts                  # ed25519 sign of fingerprint
│       ├── auth.ts                  # HS256 JWT verify
│       └── r2.ts                    # tiny R2 binding wrapper
├── src/                             # action source
│   ├── main.ts                      # setup user nix.conf + hook
│   ├── post.ts                      # cleanup
│   ├── inputs.ts                    # parse 2 inputs
│   └── cache-info.ts                # fetch /nix-cache-info, extract pubkey
├── scripts/
│   ├── setup.mjs                    # one-shot keygen + bucket + secrets
│   ├── issue-token.mjs              # mint JWTs from local jwt.secret
│   └── hook.sh                      # post-build-hook template
├── tests/
│   ├── unit/
│   │   ├── narinfo.test.ts
│   │   ├── sign.test.ts
│   │   ├── auth.test.ts
│   │   ├── inputs.test.ts
│   │   └── cache-info.test.ts
│   ├── worker/
│   │   └── integration.test.ts     # wrangler dev --local round-trip
│   └── fixtures/
│       ├── sample.narinfo
│       └── signing-test-key        # fixed ed25519 keypair for golden tests
├── examples/
│   └── basic.yml                    # consumer workflow example
├── docs/superpowers/specs/2026-05-23-serverless-attic-worker-design.md
└── README.md
```

---

## Phase 0: Cleanup + scaffolding

### Task 1: Update flake.nix devShell

**Files:**
- Modify: `flake.nix:41-49`

- [ ] **Step 1: Update the devShell to include wrangler, gh, jq**

```nix
devShells = forAll (pkgs: {
  default = pkgs.mkShellNoCC {
    packages = [
      pkgs.nodejs_24
      pkgs.nodePackages.wrangler
      pkgs.gh
      pkgs.shellcheck
      pkgs.jq
      pkgs.git
    ];
  };
});
```

- [ ] **Step 2: Verify the shell builds**

Run: `nix develop --command bash -c 'node --version && wrangler --version && gh --version && jq --version && shellcheck --version'`
Expected: each tool prints its version. No "command not found".

- [ ] **Step 3: Commit**

```bash
git add flake.nix
git commit -m "Add wrangler, gh, jq to flake devShell"
```

---

### Task 2: Delete v1 source surface

**Files:**
- Delete: `src/uploader.ts`, `src/queue.ts`, `src/contract.ts`, `src/r2.ts`, `src/paths.ts`, `src/main.ts`, `src/post.ts`, `src/inputs.ts`
- Delete: `tests/unit/queue.test.ts`, `tests/unit/r2-url.test.ts`, `tests/unit/inputs.test.ts`
- Delete: `tests/scripts/check-pushed.mjs`
- Delete: `scripts/hook.sh`
- Delete: `dist/main/`, `dist/post/`, `dist/uploader/`

- [ ] **Step 1: Remove v1 source, tests, scripts, and bundle**

```bash
rm -rf src/ tests/unit/ tests/scripts/ scripts/hook.sh dist/main dist/post dist/uploader
mkdir -p src tests/unit tests/worker tests/fixtures
```

- [ ] **Step 2: Verify the deletions**

Run: `ls src tests/unit dist 2>&1`
Expected: `src` and `tests/unit` exist and are empty. `dist` exists (possibly empty — `examples/`, `docs/`, `flake.nix`, etc. remain untouched).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Delete v1 source surface (uploader, queue, contract, paths, etc.)

Wholesale replacement: v2 lives in worker/ + a much slimmer src/.
No migration code or compat shims; v1 was unreleased."
```

---

### Task 3: Update root package.json for v2 deps

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Rewrite package.json**

```json
{
  "name": "wispy",
  "version": "0.2.0",
  "description": "GitHub Action + Cloudflare Worker: serverless Nix binary cache on R2",
  "private": true,
  "license": "MIT",
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "npm run build:main && npm run build:post",
    "build:main": "ncc build src/main.ts -o dist/main --source-map --license licenses.txt",
    "build:post": "ncc build src/post.ts -o dist/post --source-map --license licenses.txt",
    "worker:dev": "wrangler dev --config worker/wrangler.toml",
    "worker:deploy": "wrangler deploy --config worker/wrangler.toml",
    "lint": "eslint src tests worker/src scripts",
    "lint:shell": "shellcheck scripts/hook.sh",
    "typecheck": "tsc -p tsconfig.action.json --noEmit && tsc -p worker/tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "verify-dist": "npm run build && git diff --exit-code dist/"
  },
  "dependencies": {
    "@actions/core": "^1.11.0",
    "@actions/exec": "^1.1.1"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240909.0",
    "@types/node": "^24.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@vercel/ncc": "^0.38.0",
    "@vitest/coverage-v8": "^2.0.0",
    "eslint": "^9.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "wrangler": "^3.78.0"
  }
}
```

- [ ] **Step 2: Install fresh deps**

Run: `nix develop --command npm install`
Expected: `added N packages` with no errors. `wrangler` appears under `node_modules/.bin/`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "Rewrite package.json for v2: drop aws-sdk + ncc-uploader, add wrangler + workers-types"
```

---

### Task 4: Set up tsconfig split (action vs worker)

**Files:**
- Create: `tsconfig.json`, `tsconfig.action.json`, `worker/tsconfig.json`

- [ ] **Step 1: Write the base tsconfig**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noImplicitAny": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 2: Write the action tsconfig**

`tsconfig.action.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src/**/*", "tests/unit/**/*"]
}
```

- [ ] **Step 3: Write the worker tsconfig**

`worker/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*", "../tests/worker/**/*"]
}
```

- [ ] **Step 4: Verify both typecheck**

Run: `nix develop --command bash -c 'npx tsc -p tsconfig.action.json --noEmit && npx tsc -p worker/tsconfig.json --noEmit'`
Expected: no output (success). The directories may be empty so this just confirms the configs are valid.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json tsconfig.action.json worker/tsconfig.json
git commit -m "Split tsconfig: action targets Node 24, worker targets Workers runtime"
```

---

### Task 4.5: Update vitest + eslint configs for the split layout

**Files:**
- Modify: `vitest.config.ts`
- Modify: `eslint.config.js`

- [ ] **Step 1: Update vitest.config.ts**

Include both unit tests and worker integration tests; clean up coverage excludes.

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/worker/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'worker/src/**/*.ts'],
      exclude: ['src/main.ts', 'src/post.ts'],
    },
  },
});
```

- [ ] **Step 2: Update eslint.config.js**

Cover worker source + scripts; use both tsconfigs.

```javascript
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'worker/src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: ['./tsconfig.action.json', './worker/tsconfig.json'],
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      'no-console': 'off',
    },
  },
  {
    // Scripts are .mjs JavaScript — lint with relaxed rules.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/**', 'build-out/**', 'node_modules/**', '.wrangler/**'],
  },
];
```

- [ ] **Step 3: Verify both configs load**

Run: `nix develop --command bash -c 'npx vitest list 2>&1 | head -5 && npx eslint --print-config src/main.ts > /dev/null'`
Expected: vitest exits cleanly (will report no tests found yet, that's fine); eslint prints no error.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts eslint.config.js
git commit -m "Update vitest + eslint to cover worker/ and scripts/"
```

---

### Task 5: Scaffold wrangler.toml

**Files:**
- Create: `worker/wrangler.toml`

- [ ] **Step 1: Write the wrangler.toml**

`worker/wrangler.toml`:

```toml
name = "wispy"
main = "src/index.ts"
compatibility_date = "2025-01-01"

# The cache name appears in signatures: <CACHE_NAME>:<base64-sig>.
# Set to a stable identifier for this cache.
[vars]
CACHE_NAME = "wispy-default"
STORE_DIR = "/nix/store"

# Bind the R2 bucket holding nix-cache-info, narinfos, and NARs.
# setup.mjs creates the bucket and rewrites bucket_name to match.
[[r2_buckets]]
binding = "CACHE_BUCKET"
bucket_name = "wispy-default"

# Secrets (set via `wrangler secret put`):
#   SIGNING_PRIVATE_KEY  – Nix-format ed25519 private key, base64 of 64 bytes
#   JWT_ROOT_SECRET      – 32 random bytes, base64
```

- [ ] **Step 2: Sanity-check the file parses**

Run: `nix develop --command wrangler --config worker/wrangler.toml whoami`
Expected: either prints account info (if logged in) or prints "You are not authenticated" without a parse error. Either is fine — we're just confirming the toml is well-formed.

- [ ] **Step 3: Commit**

```bash
git add worker/wrangler.toml
git commit -m "Scaffold worker/wrangler.toml with R2 binding and cache-name vars"
```

---

## Phase 1: Worker — TDD

### Task 6: narinfo parser

**Files:**
- Create: `worker/src/narinfo.ts`
- Create: `tests/unit/narinfo.test.ts`
- Create: `tests/fixtures/sample.narinfo`

- [ ] **Step 1: Add a fixture**

`tests/fixtures/sample.narinfo`:

```
StorePath: /nix/store/abc123-hello-2.12.1
URL: nar/0xyz.nar.zst
Compression: zstd
FileHash: sha256:1abcdefghijklmnopqrstuvwxyz23456789abcdefghijklmnop
FileSize: 12345
NarHash: sha256:1zyxwvutsrqponmlkjihgfedcba98765432123456789abcdefg
NarSize: 67890
References: def456-glibc-2.40 ghi789-libc++-19
Deriver: jkl012-hello-2.12.1.drv
```

- [ ] **Step 2: Write failing tests**

`tests/unit/narinfo.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNarinfo, serializeNarinfo, fingerprint, type Narinfo } from '../../worker/src/narinfo.js';

const fixturePath = (name: string) =>
  join(import.meta.dirname, '..', 'fixtures', name);

describe('parseNarinfo', () => {
  it('extracts every required field from the fixture', () => {
    const text = readFileSync(fixturePath('sample.narinfo'), 'utf8');
    const n = parseNarinfo(text);
    expect(n.storePath).toBe('/nix/store/abc123-hello-2.12.1');
    expect(n.url).toBe('nar/0xyz.nar.zst');
    expect(n.compression).toBe('zstd');
    expect(n.fileHash).toBe('sha256:1abcdefghijklmnopqrstuvwxyz23456789abcdefghijklmnop');
    expect(n.fileSize).toBe(12345);
    expect(n.narHash).toBe('sha256:1zyxwvutsrqponmlkjihgfedcba98765432123456789abcdefg');
    expect(n.narSize).toBe(67890);
    expect(n.references).toEqual(['def456-glibc-2.40', 'ghi789-libc++-19']);
    expect(n.deriver).toBe('jkl012-hello-2.12.1.drv');
    expect(n.sig).toBeUndefined();
  });

  it('handles an empty References field as an empty array', () => {
    const text = 'StorePath: /nix/store/abc-name\nURL: nar/x.nar.zst\nCompression: zstd\nFileHash: sha256:a\nFileSize: 1\nNarHash: sha256:b\nNarSize: 2\nReferences: \n';
    const n = parseNarinfo(text);
    expect(n.references).toEqual([]);
  });

  it('throws on missing required fields', () => {
    expect(() => parseNarinfo('StorePath: /nix/store/x\n')).toThrow(/missing required/i);
  });
});

describe('serializeNarinfo', () => {
  it('emits Nix-canonical key order with a trailing newline', () => {
    const n: Narinfo = {
      storePath: '/nix/store/abc-name',
      url: 'nar/x.nar.zst',
      compression: 'zstd',
      fileHash: 'sha256:a',
      fileSize: 1,
      narHash: 'sha256:b',
      narSize: 2,
      references: ['ref1-name'],
      deriver: 'd.drv',
      sig: 'cache-1:abc==',
    };
    expect(serializeNarinfo(n)).toBe(
      'StorePath: /nix/store/abc-name\n' +
      'URL: nar/x.nar.zst\n' +
      'Compression: zstd\n' +
      'FileHash: sha256:a\n' +
      'FileSize: 1\n' +
      'NarHash: sha256:b\n' +
      'NarSize: 2\n' +
      'References: ref1-name\n' +
      'Deriver: d.drv\n' +
      'Sig: cache-1:abc==\n'
    );
  });

  it('omits Deriver and Sig when absent', () => {
    const n: Narinfo = {
      storePath: '/nix/store/abc-name',
      url: 'nar/x.nar.zst',
      compression: 'zstd',
      fileHash: 'sha256:a',
      fileSize: 1,
      narHash: 'sha256:b',
      narSize: 2,
      references: [],
    };
    const s = serializeNarinfo(n);
    expect(s).not.toContain('Deriver');
    expect(s).not.toContain('Sig');
  });
});

describe('fingerprint', () => {
  it('matches the Nix C++ format: 1;<storePath>;<narHash>;<narSize>;<refs joined by comma>', () => {
    const n: Narinfo = {
      storePath: '/nix/store/abc-name',
      url: 'nar/x',
      compression: 'zstd',
      fileHash: 'sha256:a',
      fileSize: 1,
      narHash: 'sha256:nh',
      narSize: 42,
      references: ['def-r1', 'ghi-r2'],
    };
    expect(fingerprint(n, '/nix/store')).toBe(
      '1;/nix/store/abc-name;sha256:nh;42;/nix/store/def-r1,/nix/store/ghi-r2'
    );
  });

  it('emits an empty refs section when references is empty', () => {
    const n: Narinfo = {
      storePath: '/nix/store/abc-name',
      url: 'nar/x',
      compression: 'zstd',
      fileHash: 'sha256:a',
      fileSize: 1,
      narHash: 'sha256:nh',
      narSize: 42,
      references: [],
    };
    expect(fingerprint(n, '/nix/store')).toBe('1;/nix/store/abc-name;sha256:nh;42;');
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `nix develop --command npx vitest run tests/unit/narinfo.test.ts`
Expected: FAIL — `Cannot find module '../../worker/src/narinfo.js'`.

- [ ] **Step 4: Implement narinfo.ts**

`worker/src/narinfo.ts`:

```typescript
export interface Narinfo {
  storePath: string;
  url: string;
  compression: string;
  fileHash: string;
  fileSize: number;
  narHash: string;
  narSize: number;
  references: string[];
  deriver?: string;
  sig?: string;
}

const REQUIRED = ['StorePath', 'URL', 'Compression', 'FileHash', 'FileSize', 'NarHash', 'NarSize'] as const;

export function parseNarinfo(text: string): Narinfo {
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    fields[key] = value;
  }
  for (const k of REQUIRED) {
    if (!(k in fields)) throw new Error(`narinfo missing required field: ${k}`);
  }
  const refsRaw = fields['References'] ?? '';
  const references = refsRaw.length === 0 ? [] : refsRaw.split(/\s+/).filter(Boolean);
  return {
    storePath: fields['StorePath']!,
    url: fields['URL']!,
    compression: fields['Compression']!,
    fileHash: fields['FileHash']!,
    fileSize: Number.parseInt(fields['FileSize']!, 10),
    narHash: fields['NarHash']!,
    narSize: Number.parseInt(fields['NarSize']!, 10),
    references,
    deriver: fields['Deriver'],
    sig: fields['Sig'],
  };
}

export function serializeNarinfo(n: Narinfo): string {
  const lines = [
    `StorePath: ${n.storePath}`,
    `URL: ${n.url}`,
    `Compression: ${n.compression}`,
    `FileHash: ${n.fileHash}`,
    `FileSize: ${n.fileSize}`,
    `NarHash: ${n.narHash}`,
    `NarSize: ${n.narSize}`,
    `References: ${n.references.join(' ')}`,
  ];
  if (n.deriver !== undefined) lines.push(`Deriver: ${n.deriver}`);
  if (n.sig !== undefined) lines.push(`Sig: ${n.sig}`);
  return lines.join('\n') + '\n';
}

// Fingerprint formula from Nix source (libstore/path-info.cc): the bytes that
// the signature must cover. References are joined by comma, prefixed with the
// store directory to form full store paths.
export function fingerprint(n: Narinfo, storeDir: string): string {
  const refs = n.references.map((r) => `${storeDir}/${r}`).join(',');
  return `1;${n.storePath};${n.narHash};${n.narSize};${refs}`;
}
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `nix develop --command npx vitest run tests/unit/narinfo.test.ts`
Expected: PASS, 7 tests passing.

- [ ] **Step 6: Commit**

```bash
git add worker/src/narinfo.ts tests/unit/narinfo.test.ts tests/fixtures/sample.narinfo
git commit -m "Add narinfo parser, serializer, and fingerprint formula"
```

---

### Task 7: ed25519 signing

**Files:**
- Create: `worker/src/sign.ts`
- Create: `tests/unit/sign.test.ts`
- Create: `tests/fixtures/signing-test-key.json`

- [ ] **Step 1: Generate a fixed test keypair**

Run: `nix develop --command node -e '
const c = require("node:crypto");
const { publicKey, privateKey } = c.generateKeyPairSync("ed25519");
const priv = privateKey.export({ format: "der", type: "pkcs8" });
const pub = publicKey.export({ format: "der", type: "spki" });
const rawPriv = priv.subarray(priv.length - 32);
const rawPub = pub.subarray(pub.length - 32);
process.stdout.write(JSON.stringify({
  name: "wispy-test-1",
  privateKeyBase64: Buffer.concat([rawPriv, rawPub]).toString("base64"),
  publicKeyBase64: rawPub.toString("base64"),
}, null, 2) + "\n");
' > tests/fixtures/signing-test-key.json`
Expected: writes a JSON object with `name`, `privateKeyBase64` (64 bytes base64), and `publicKeyBase64` (32 bytes base64). Nix represents ed25519 private keys as 32-byte seed concatenated with the 32-byte public key, base64-encoded — that's the format we store.

- [ ] **Step 2: Write the failing test**

`tests/unit/sign.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { signFingerprint, type SigningKey } from '../../worker/src/sign.js';

const key: SigningKey = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'signing-test-key.json'), 'utf8')
);

function ed25519PubFromRaw(raw: Buffer) {
  // SPKI prefix for ed25519: 12 bytes, then 32-byte key.
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
}

describe('signFingerprint', () => {
  it('produces a Nix-format Sig line that verifies with the matching public key', () => {
    const fingerprint = '1;/nix/store/abc-name;sha256:nh;42;';
    const sig = signFingerprint(fingerprint, key);

    expect(sig).toMatch(/^wispy-test-1:[A-Za-z0-9+/]+=*$/);
    const [, base64] = sig.split(':');
    const sigBytes = Buffer.from(base64!, 'base64');
    expect(sigBytes.length).toBe(64);

    const pubKey = ed25519PubFromRaw(Buffer.from(key.publicKeyBase64, 'base64'));
    const ok = verify(null, Buffer.from(fingerprint, 'utf8'), pubKey, sigBytes);
    expect(ok).toBe(true);
  });

  it('produces deterministic signatures for the same input', () => {
    const a = signFingerprint('input', key);
    const b = signFingerprint('input', key);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 3: Run, verify fails**

Run: `nix develop --command npx vitest run tests/unit/sign.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement sign.ts**

`worker/src/sign.ts`:

```typescript
// Web Crypto is what runs on Cloudflare Workers — we deliberately do not
// import from 'node:crypto' here. The same code runs unchanged under both
// the Workers runtime and Node 24 (which exposes the same WebCrypto API).

export interface SigningKey {
  name: string;
  privateKeyBase64: string; // 32-byte seed || 32-byte public key, base64
  publicKeyBase64: string;  // 32-byte public key, base64
}

function base64ToBytes(b64: string): Uint8Array {
  // atob is available in both Workers and Node 24.
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

// PKCS#8 prefix for an ed25519 private key with raw seed appended.
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

async function importPrivateKey(key: SigningKey): Promise<CryptoKey> {
  const combined = base64ToBytes(key.privateKeyBase64);
  if (combined.length !== 64) {
    throw new Error(`expected 64-byte private key, got ${combined.length}`);
  }
  const seed = combined.subarray(0, 32);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

export async function signFingerprint(fingerprint: string, key: SigningKey): Promise<string> {
  const priv = await importPrivateKey(key);
  const data = new TextEncoder().encode(fingerprint);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, priv, data);
  return `${key.name}:${bytesToBase64(new Uint8Array(sig))}`;
}
```

- [ ] **Step 5: Update the test to await the async sign function**

The implementation is async (Web Crypto's `subtle.sign` is). Update the test:

```typescript
  it('produces a Nix-format Sig line that verifies with the matching public key', async () => {
    const fingerprint = '1;/nix/store/abc-name;sha256:nh;42;';
    const sig = await signFingerprint(fingerprint, key);
    // ...rest unchanged...
  });

  it('produces deterministic signatures for the same input', async () => {
    const a = await signFingerprint('input', key);
    const b = await signFingerprint('input', key);
    expect(a).toBe(b);
  });
```

- [ ] **Step 6: Run, verify passes**

Run: `nix develop --command npx vitest run tests/unit/sign.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add worker/src/sign.ts tests/unit/sign.test.ts tests/fixtures/signing-test-key.json
git commit -m "Add Web Crypto ed25519 signer that matches Nix's Sig: format"
```

---

### Task 8: HS256 JWT auth

**Files:**
- Create: `worker/src/auth.ts`
- Create: `tests/unit/auth.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/unit/auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { issueToken, verifyToken, type TokenPayload } from '../../worker/src/auth.js';

const secret = new TextEncoder().encode('test-secret-do-not-use-in-prod');

describe('verifyToken', () => {
  it('accepts a freshly minted push token', async () => {
    const jwt = await issueToken({ scope: 'push' }, secret);
    const payload = await verifyToken(jwt, secret);
    expect(payload.scope).toBe('push');
  });

  it('rejects a token signed with a different secret', async () => {
    const jwt = await issueToken({ scope: 'push' }, secret);
    const other = new TextEncoder().encode('wrong-secret');
    await expect(verifyToken(jwt, other)).rejects.toThrow(/signature/i);
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const jwt = await issueToken({ scope: 'push', exp: past }, secret);
    await expect(verifyToken(jwt, secret)).rejects.toThrow(/expired/i);
  });

  it('accepts a token without exp claim', async () => {
    const jwt = await issueToken({ scope: 'pull' }, secret);
    const payload = await verifyToken(jwt, secret);
    expect(payload.scope).toBe('pull');
    expect(payload.exp).toBeUndefined();
  });

  it('rejects malformed tokens', async () => {
    await expect(verifyToken('not.a.jwt', secret)).rejects.toThrow();
    await expect(verifyToken('', secret)).rejects.toThrow();
    await expect(verifyToken('only.two', secret)).rejects.toThrow();
  });

  it('rejects a token with scope tampering (constant-time guarantee)', async () => {
    const jwt = await issueToken({ scope: 'pull' }, secret);
    // Re-encode payload claiming push, keeping the original signature.
    const [header, , sig] = jwt.split('.');
    const tampered = JSON.stringify({ scope: 'push', iat: 0 });
    const tamperedB64 = btoa(tampered).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const evil = `${header}.${tamperedB64}.${sig}`;
    await expect(verifyToken(evil, secret)).rejects.toThrow(/signature/i);
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `nix develop --command npx vitest run tests/unit/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement auth.ts**

`worker/src/auth.ts`:

```typescript
export interface TokenPayload {
  scope: 'push' | 'pull';
  iat?: number;
  exp?: number;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function issueToken(payload: TokenPayload, secret: Uint8Array): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = new TextEncoder();
  const iat = payload.iat ?? Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat };
  const headerB64 = b64urlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  const sigB64 = b64urlEncode(new Uint8Array(sig));
  return `${signingInput}.${sigB64}`;
}

export async function verifyToken(jwt: string, secret: Uint8Array): Promise<TokenPayload> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('jwt: expected 3 segments');
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const enc = new TextEncoder();
  const key = await hmacKey(secret);
  const sigBytes = b64urlDecode(sigB64);
  const signingInput = enc.encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, signingInput);
  if (!ok) throw new Error('jwt: bad signature');

  const payloadJson = new TextDecoder().decode(b64urlDecode(payloadB64));
  const payload = JSON.parse(payloadJson) as TokenPayload;

  if (payload.exp !== undefined) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= payload.exp) throw new Error('jwt: expired');
  }
  if (payload.scope !== 'push' && payload.scope !== 'pull') {
    throw new Error(`jwt: invalid scope "${payload.scope}"`);
  }
  return payload;
}
```

- [ ] **Step 4: Run, verify passes**

Run: `nix develop --command npx vitest run tests/unit/auth.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add worker/src/auth.ts tests/unit/auth.test.ts
git commit -m "Add HS256 JWT issue + verify using Web Crypto"
```

---

### Task 9: R2 wrapper

**Files:**
- Create: `worker/src/r2.ts`

- [ ] **Step 1: Implement r2.ts**

This is a thin abstraction so we can mock the binding in tests. No standalone unit test — covered by the worker integration test in Task 11.

`worker/src/r2.ts`:

```typescript
// Minimal interface over R2 we depend on. Lets index.ts be tested with a
// fake without pulling in the full Workers runtime.
export interface R2Like {
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; httpEtag: string } | null>;
  head(key: string): Promise<{ httpEtag: string } | null>;
  put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | string): Promise<{ key: string }>;
}

// The actual Workers R2Bucket binding satisfies this shape modulo extras.
export function r2FromBinding(bucket: R2Bucket): R2Like {
  return {
    async get(key) {
      const obj = await bucket.get(key);
      if (obj === null) return null;
      return { body: obj.body, httpEtag: obj.httpEtag };
    },
    async head(key) {
      const obj = await bucket.head(key);
      if (obj === null) return null;
      return { httpEtag: obj.httpEtag };
    },
    async put(key, value) {
      const obj = await bucket.put(key, value as ReadableStream<Uint8Array>);
      return { key: obj.key };
    },
  };
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `nix develop --command npx tsc -p worker/tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add worker/src/r2.ts
git commit -m "Add R2Like interface + binding adapter for testability"
```

---

### Task 10: Worker router + handlers

**Files:**
- Create: `worker/src/index.ts`

- [ ] **Step 1: Implement index.ts**

`worker/src/index.ts`:

```typescript
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const r2 = r2FromBinding(env.CACHE_BUCKET);

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
  },
};
```

- [ ] **Step 2: Verify it typechecks**

Run: `nix develop --command npx tsc -p worker/tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add worker/src/index.ts
git commit -m "Add Worker router: GET/PUT nix-cache-info, narinfo, NAR"
```

---

### Task 11: Worker integration test (wrangler dev --local)

**Files:**
- Create: `tests/worker/integration.test.ts`

- [ ] **Step 1: Write the test**

This test spawns `wrangler dev --local`, exercises the full HTTP surface, and uses the test signing key + the same JWT we issue in CI. It runs separately from unit tests because it spins up a server.

`tests/worker/integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueToken } from '../../worker/src/auth.js';

type Key = { name: string; privateKeyBase64: string; publicKeyBase64: string };
const key: Key = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'signing-test-key.json'), 'utf8'));
const SIGNING_PRIVATE_KEY = `${key.name}:${key.privateKeyBase64}`;
const JWT_ROOT_SECRET = btoa('integration-test-secret-32-bytes');

let proc: ChildProcess;
let baseUrl: string;
let tmp: string;

async function waitFor(url: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`wrangler dev not reachable at ${url} after ${timeoutMs}ms`);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'wispy-it-'));
  // Pre-populate nix-cache-info in a known location wrangler dev --local serves
  // from. wrangler-local stores R2 contents under .wrangler/state/v3/r2/<bucket>/
  // by default; easiest is to upload via the Worker after it's up.

  proc = spawn(
    'wrangler',
    [
      'dev',
      '--config', 'worker/wrangler.toml',
      '--local',
      '--port', '0',
      '--ip', '127.0.0.1',
      '--var', `SIGNING_PRIVATE_KEY:${SIGNING_PRIVATE_KEY}`,
      '--var', `JWT_ROOT_SECRET:${JWT_ROOT_SECRET}`,
      '--var', 'CACHE_NAME:wispy-it',
      '--var', 'STORE_DIR:/nix/store',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    proc.stdout!.on('data', (chunk: Buffer) => {
      const m = /Ready on http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (m) resolve(Number(m[1]));
    });
    proc.once('exit', (code) => reject(new Error(`wrangler exited early (${code})`)));
  });
  baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(`${baseUrl}/nix-cache-info`);
}, 60000);

afterAll(async () => {
  if (proc) {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.once('exit', r));
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('worker round-trip', () => {
  it('rejects PUT without bearer', async () => {
    const r = await fetch(`${baseUrl}/abc.narinfo`, {
      method: 'PUT',
      body: 'StorePath: /nix/store/abc\n',
    });
    expect(r.status).toBe(401);
  });

  it('accepts a PUT with a push token, then GETs it back signed', async () => {
    const token = await issueToken(
      { scope: 'push' },
      Uint8Array.from(atob(JWT_ROOT_SECRET), (c) => c.charCodeAt(0)),
    );

    // Seed nix-cache-info first so GET /nix-cache-info works after upload.
    const cacheInfoBody = `StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\n`;
    const seedR = await fetch(`${baseUrl}/nix-cache-info-seed`, { method: 'GET' });
    // (No seed endpoint; rely on bucket pre-population if integration env supports it.)

    const narinfo = [
      'StorePath: /nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-hello',
      'URL: nar/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.nar.zst',
      'Compression: zstd',
      'FileHash: sha256:abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop',
      'FileSize: 1234',
      'NarHash: sha256:1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMnop',
      'NarSize: 5678',
      'References: ',
      '',
    ].join('\n');

    const put = await fetch(`${baseUrl}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.narinfo`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      body: narinfo,
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${baseUrl}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.narinfo`);
    expect(get.status).toBe(200);
    const text = await get.text();
    expect(text).toMatch(/^Sig: wispy-it:/m);
  });
});
```

> Note: this integration test depends on `wrangler dev --local` accepting `--var` overrides for secrets, and on the bucket being in-memory. If `wrangler dev` doesn't support the `--var` flag for the value of `[[r2_buckets]]` bindings, the test must be adjusted to use a local SQLite-backed R2 mock (`miniflare` is built into `wrangler dev --local`). Treat the test code above as the contract; tweak the harness if wrangler ergonomics differ.

- [ ] **Step 2: Run, verify it executes (may need wrangler login skip)**

Run: `nix develop --command npx vitest run tests/worker/integration.test.ts`
Expected: PASS. If wrangler complains about login, set `CLOUDFLARE_API_TOKEN=dummy` for the local test or pass `--no-bundle-check`.

- [ ] **Step 3: Commit**

```bash
git add tests/worker/integration.test.ts
git commit -m "Add Worker integration test: PUT narinfo, server signs, GET back"
```

---

## Phase 2: Scripts

### Task 12: hook.sh template

**Files:**
- Create: `scripts/hook.sh`

- [ ] **Step 1: Write the template**

`scripts/hook.sh`:

```bash
#!/usr/bin/env bash
# wispy post-build-hook. nix-daemon fires this with OUT_PATHS set to the
# (space-separated) store paths just built. We push to the configured
# wispy Worker via standard `nix copy`. The Worker authenticates and signs.
#
# Placeholders __WISPY_NIX_CONF__ and __WISPY_SERVER_URL__ are substituted
# by src/main.ts when the action materializes this file.
#
# NIX_USER_CONF_FILES is re-exported explicitly because the daemon does not
# propagate the action's environment to spawned hooks.
set -u
export NIX_USER_CONF_FILES="__WISPY_NIX_CONF__"
exec nix copy --to "__WISPY_SERVER_URL__" $OUT_PATHS
```

- [ ] **Step 2: Lint with shellcheck**

Run: `nix develop --command shellcheck scripts/hook.sh`
Expected: no output. (Shellcheck will accept the placeholder strings because they're literal tokens.)

- [ ] **Step 3: Commit**

```bash
git add scripts/hook.sh
git commit -m "Add post-build-hook template that delegates to nix copy"
```

---

### Task 13: issue-token script

**Files:**
- Create: `scripts/issue-token.mjs`

- [ ] **Step 1: Implement issue-token.mjs**

`scripts/issue-token.mjs`:

```javascript
#!/usr/bin/env node
// Mint a wispy JWT from the local jwt.secret that setup.mjs wrote.
// Reads --cache <name> to locate ~/.wispy/<name>/jwt.secret.
// Emits the JWT to stdout.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import { issueToken } from '../worker/src/auth.js';

function parseArgs(args) {
  const out = { scope: undefined, cache: undefined, expires: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scope') out.scope = args[++i];
    else if (args[i] === '--cache') out.cache = args[++i];
    else if (args[i] === '--expires') out.expires = args[++i];
    else {
      console.error(`unknown arg: ${args[i]}`);
      exit(2);
    }
  }
  return out;
}

function parseDuration(s) {
  // Accept "90d", "24h", "3600" (seconds).
  const m = /^(\d+)([dhms]?)$/.exec(s);
  if (!m) throw new Error(`bad --expires: ${s}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case 'd': return n * 86400;
    case 'h': return n * 3600;
    case 'm': return n * 60;
    default: return n;
  }
}

const args = parseArgs(argv.slice(2));
if (args.scope !== 'push' && args.scope !== 'pull') {
  console.error('usage: issue-token.mjs --cache <name> --scope push|pull [--expires 90d]');
  exit(2);
}
if (!args.cache) {
  console.error('usage: issue-token.mjs --cache <name> --scope push|pull [--expires 90d]');
  exit(2);
}

const secretPath = join(homedir(), '.wispy', args.cache, 'jwt.secret');
let secretB64;
try {
  secretB64 = readFileSync(secretPath, 'utf8').trim();
} catch (err) {
  console.error(`cannot read ${secretPath}: ${err.message}`);
  console.error(`run scripts/setup.mjs --cache ${args.cache} first`);
  exit(1);
}
const secret = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));

const payload = { scope: args.scope };
if (args.expires) {
  payload.exp = Math.floor(Date.now() / 1000) + parseDuration(args.expires);
}
const jwt = await issueToken(payload, secret);
process.stdout.write(jwt + '\n');
```

- [ ] **Step 2: Run a smoke test (no jwt.secret yet — expect exit 1)**

Run: `nix develop --command node scripts/issue-token.mjs --cache nonexistent --scope push 2>&1; echo "exit=$?"`
Expected: error about cannot read ~/.wispy/nonexistent/jwt.secret, exit=1.

- [ ] **Step 3: Smoke test happy path**

Run:

```bash
nix develop --command bash -c '
mkdir -p $HOME/.wispy/it-test
head -c 32 /dev/urandom | base64 > $HOME/.wispy/it-test/jwt.secret
node scripts/issue-token.mjs --cache it-test --scope push
rm -rf $HOME/.wispy/it-test
'
```

Expected: prints a JWT (three dot-separated base64url segments).

- [ ] **Step 4: Commit**

```bash
git add scripts/issue-token.mjs
git commit -m "Add issue-token.mjs: mint scoped JWT from ~/.wispy/<cache>/jwt.secret"
```

---

### Task 14: setup.mjs

**Files:**
- Create: `scripts/setup.mjs`

- [ ] **Step 1: Implement setup.mjs**

`scripts/setup.mjs`:

```javascript
#!/usr/bin/env node
// One-shot wispy cache setup.
//   - Generates an ed25519 keypair (Nix-format: <name>:<base64-of-64-bytes>)
//   - Generates a 32-byte JWT_ROOT_SECRET
//   - Saves both to ~/.wispy/<cache>/  mode 0600
//   - Updates worker/wrangler.toml with the bucket name + CACHE_NAME
//   - Creates the R2 bucket via `wrangler r2 bucket create`
//   - Uploads nix-cache-info to R2 via `wrangler r2 object put`
//   - Uploads SIGNING_PRIVATE_KEY and JWT_ROOT_SECRET via `wrangler secret put`

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import { spawnSync } from 'node:child_process';

function parseArgs(args) {
  const out = { cache: undefined, bucket: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cache') out.cache = args[++i];
    else if (args[i] === '--bucket') out.bucket = args[++i];
    else {
      console.error(`unknown arg: ${args[i]}`);
      exit(2);
    }
  }
  return out;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'], ...opts });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(' ')} failed with exit ${r.status}`);
    exit(r.status ?? 1);
  }
  return r;
}

function runWithStdin(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(' ')} failed with exit ${r.status}`);
    exit(r.status ?? 1);
  }
}

const args = parseArgs(argv.slice(2));
if (!args.cache || !args.bucket) {
  console.error('usage: setup.mjs --cache <name> --bucket <r2-bucket-name>');
  exit(2);
}

// 1. ed25519 keypair, Nix-format private key.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
const pubDer = publicKey.export({ format: 'der', type: 'spki' });
const seed = privDer.subarray(privDer.length - 32);
const pub = pubDer.subarray(pubDer.length - 32);
const privNix = `${args.cache}:${Buffer.concat([seed, pub]).toString('base64')}`;
const pubNix = `${args.cache}:${pub.toString('base64')}`;

// 2. JWT root secret.
const jwtSecret = randomBytes(32).toString('base64');

// 3. Save locally.
const wispyDir = join(homedir(), '.wispy', args.cache);
mkdirSync(wispyDir, { recursive: true, mode: 0o700 });
writeFileSync(join(wispyDir, 'signing-private-key'), privNix + '\n', { mode: 0o600 });
writeFileSync(join(wispyDir, 'signing-public-key'), pubNix + '\n', { mode: 0o600 });
writeFileSync(join(wispyDir, 'jwt.secret'), jwtSecret + '\n', { mode: 0o600 });
chmodSync(join(wispyDir, 'signing-private-key'), 0o600);
chmodSync(join(wispyDir, 'jwt.secret'), 0o600);

console.log(`wrote ${wispyDir}/{signing-private-key, signing-public-key, jwt.secret}`);

// 4. Patch worker/wrangler.toml.
const tomlPath = 'worker/wrangler.toml';
let toml = readFileSync(tomlPath, 'utf8');
toml = toml.replace(/^CACHE_NAME = .*/m, `CACHE_NAME = "${args.cache}"`);
toml = toml.replace(/^bucket_name = .*/m, `bucket_name = "${args.bucket}"`);
writeFileSync(tomlPath, toml);
console.log(`patched ${tomlPath}: CACHE_NAME=${args.cache}, bucket_name=${args.bucket}`);

// 5. Create the R2 bucket (idempotent: ignore "already exists").
console.log(`creating R2 bucket ${args.bucket}...`);
const createR = spawnSync('wrangler', ['r2', 'bucket', 'create', args.bucket], { stdio: ['ignore', 'inherit', 'pipe'] });
if (createR.status !== 0) {
  const err = createR.stderr?.toString() ?? '';
  if (!/already exists/i.test(err)) {
    console.error(err);
    exit(createR.status ?? 1);
  }
  console.log('(already exists, continuing)');
}

// 6. Upload nix-cache-info.
const cacheInfo = `StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\n`;
const tmpInfoPath = join(wispyDir, 'nix-cache-info');
writeFileSync(tmpInfoPath, cacheInfo);
run('wrangler', ['r2', 'object', 'put', `${args.bucket}/nix-cache-info`, '--file', tmpInfoPath, '--content-type', 'text/x-nix-cache-info']);

// 7. Upload secrets.
console.log('uploading SIGNING_PRIVATE_KEY...');
runWithStdin('wrangler', ['secret', 'put', 'SIGNING_PRIVATE_KEY', '--config', 'worker/wrangler.toml'], privNix);

console.log('uploading JWT_ROOT_SECRET...');
runWithStdin('wrangler', ['secret', 'put', 'JWT_ROOT_SECRET', '--config', 'worker/wrangler.toml'], jwtSecret);

console.log('\nsetup complete. next:');
console.log('  wrangler deploy --config worker/wrangler.toml');
console.log(`  node scripts/issue-token.mjs --cache ${args.cache} --scope push`);
```

- [ ] **Step 2: Smoke test against a real R2 (manual)**

This script makes real Cloudflare API calls. There's no clean way to test it in an automated suite. Manual smoke test:

Run: `nix develop --command bash -c 'wrangler login && node scripts/setup.mjs --cache testcache-$(date +%s) --bucket wispy-test-$(date +%s)'`
Expected: completes without error; ~/.wispy/<cache>/ populated; secrets uploaded; R2 bucket created; wrangler.toml updated.

Skip this step during normal plan execution — defer to the operator at deploy time.

- [ ] **Step 3: Commit**

```bash
git add scripts/setup.mjs
git commit -m "Add setup.mjs: keygen, bucket, secrets, wrangler.toml patching"
```

---

## Phase 3: Action

### Task 15: inputs.ts

**Files:**
- Create: `src/inputs.ts`
- Create: `tests/unit/inputs.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/inputs.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseInputs, type RawInputs } from '../../src/inputs.js';

function raw(o: Partial<RawInputs> = {}): RawInputs {
  return { 'server-url': '', token: '', ...o };
}

describe('parseInputs', () => {
  it('parses a complete set of inputs', () => {
    const r = parseInputs(raw({ 'server-url': 'https://cache.example.com', token: 'eyJ...' }));
    expect(r.serverUrl).toBe('https://cache.example.com');
    expect(r.token).toBe('eyJ...');
  });

  it('rejects empty server-url', () => {
    expect(() => parseInputs(raw({ token: 'x' }))).toThrow(/server-url/);
  });

  it('rejects empty token', () => {
    expect(() => parseInputs(raw({ 'server-url': 'https://x' }))).toThrow(/token/);
  });

  it('rejects non-https server-url', () => {
    expect(() => parseInputs(raw({ 'server-url': 'http://x', token: 'y' }))).toThrow(/https/i);
  });

  it('strips a trailing slash from server-url', () => {
    const r = parseInputs(raw({ 'server-url': 'https://x/', token: 'y' }));
    expect(r.serverUrl).toBe('https://x');
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `nix develop --command npx vitest run tests/unit/inputs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement inputs.ts**

`src/inputs.ts`:

```typescript
export interface RawInputs {
  'server-url': string;
  token: string;
}

export interface Inputs {
  serverUrl: string;
  token: string;
}

export function parseInputs(raw: RawInputs): Inputs {
  const serverUrl = (raw['server-url'] ?? '').trim();
  const token = (raw.token ?? '').trim();
  if (!serverUrl) throw new Error('input "server-url" is required');
  if (!token) throw new Error('input "token" is required');
  if (!serverUrl.startsWith('https://')) {
    throw new Error('"server-url" must use https');
  }
  return {
    serverUrl: serverUrl.replace(/\/+$/, ''),
    token,
  };
}
```

- [ ] **Step 4: Run, verify passes**

Run: `nix develop --command npx vitest run tests/unit/inputs.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/inputs.ts tests/unit/inputs.test.ts
git commit -m "Add action input parser: server-url + token, https + trim"
```

---

### Task 16: cache-info.ts

**Files:**
- Create: `src/cache-info.ts`
- Create: `tests/unit/cache-info.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/cache-info.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseCacheInfo } from '../../src/cache-info.js';

describe('parseCacheInfo', () => {
  it('extracts StoreDir and Priority', () => {
    const text = 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\n';
    const info = parseCacheInfo(text);
    expect(info.storeDir).toBe('/nix/store');
    expect(info.priority).toBe(30);
    expect(info.wantMassQuery).toBe(true);
  });

  it('defaults WantMassQuery to false when absent', () => {
    const info = parseCacheInfo('StoreDir: /nix/store\nPriority: 50\n');
    expect(info.wantMassQuery).toBe(false);
  });

  it('throws if StoreDir is missing', () => {
    expect(() => parseCacheInfo('Priority: 30\n')).toThrow(/StoreDir/);
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `nix develop --command npx vitest run tests/unit/cache-info.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement cache-info.ts**

`src/cache-info.ts`:

```typescript
export interface CacheInfo {
  storeDir: string;
  priority: number;
  wantMassQuery: boolean;
}

export function parseCacheInfo(text: string): CacheInfo {
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!fields['StoreDir']) throw new Error('nix-cache-info missing StoreDir');
  return {
    storeDir: fields['StoreDir'],
    priority: Number.parseInt(fields['Priority'] ?? '50', 10),
    wantMassQuery: fields['WantMassQuery'] === '1',
  };
}

export async function fetchCacheInfo(serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<CacheInfo> {
  const res = await fetchImpl(`${serverUrl}/nix-cache-info`);
  if (!res.ok) {
    throw new Error(`GET /nix-cache-info → ${res.status} ${res.statusText}`);
  }
  return parseCacheInfo(await res.text());
}
```

> Note: the public key isn't in the spec's `nix-cache-info` output above. Nix's `nix-cache-info` format **does not** carry a `Sig` or `PublicKeys` line — those are not part of the file. Public keys are configured separately in the consumer's `trusted-public-keys`. The setup script writes the pubkey to `~/.wispy/<cache>/signing-public-key` for the operator to provide as a workflow input or to publish via README. The action must also receive the pubkey to set `trusted-public-keys`. **This is a spec gap — fix it in the next task by adding a `public-key` input.**

- [ ] **Step 4: Run, verify passes**

Run: `nix develop --command npx vitest run tests/unit/cache-info.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cache-info.ts tests/unit/cache-info.test.ts
git commit -m "Add cache-info parser + fetcher (StoreDir, Priority, WantMassQuery)"
```

---

### Task 17: Reconcile spec gap — pubkey discovery

The spec assumes the action fetches the pubkey from `/nix-cache-info`, but the standard `nix-cache-info` text format has no public-key field. Two options:

**(A)** Add a `Wispy-PublicKey:` extension field to our nix-cache-info (Nix ignores unknown fields). The Worker writes it; the action reads it. Custom but contained.

**(B)** Add a third input `public-key` to the action. Operator pastes the pubkey from `~/.wispy/<cache>/signing-public-key` as a GitHub variable. Two vars, one secret. Slight UX hit; no protocol invention.

This plan ships **(A)**: extend nix-cache-info with `Wispy-PublicKey: <name:base64>`. Nix's nix-cache-info parser tolerates unknown keys, and we keep the "one secret + one var" promise.

**Files:**
- Modify: `scripts/setup.mjs` (write `Wispy-PublicKey` line)
- Modify: `src/cache-info.ts` (parse it)
- Modify: `tests/unit/cache-info.test.ts` (cover it)

- [ ] **Step 1: Update setup.mjs to include the Wispy-PublicKey line**

In `scripts/setup.mjs`, change the nix-cache-info body:

```javascript
const cacheInfo =
  `StoreDir: /nix/store\n` +
  `WantMassQuery: 1\n` +
  `Priority: 30\n` +
  `Wispy-PublicKey: ${pubNix}\n`;
```

- [ ] **Step 2: Extend cache-info.ts**

In `src/cache-info.ts`:

```typescript
export interface CacheInfo {
  storeDir: string;
  priority: number;
  wantMassQuery: boolean;
  publicKey: string; // <name>:<base64 of 32 bytes>, from Wispy-PublicKey
}

// ...inside parseCacheInfo:
if (!fields['Wispy-PublicKey']) throw new Error('nix-cache-info missing Wispy-PublicKey');
return {
  storeDir: fields['StoreDir'],
  priority: Number.parseInt(fields['Priority'] ?? '50', 10),
  wantMassQuery: fields['WantMassQuery'] === '1',
  publicKey: fields['Wispy-PublicKey'],
};
```

- [ ] **Step 3: Extend the cache-info test**

Add to `tests/unit/cache-info.test.ts`:

```typescript
  it('extracts Wispy-PublicKey', () => {
    const text = 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\nWispy-PublicKey: cache-1:AAAA==\n';
    const info = parseCacheInfo(text);
    expect(info.publicKey).toBe('cache-1:AAAA==');
  });

  it('throws when Wispy-PublicKey is missing', () => {
    expect(() => parseCacheInfo('StoreDir: /nix/store\n')).toThrow(/Wispy-PublicKey/);
  });
```

Update existing tests to include `Wispy-PublicKey` in their fixtures so they still pass.

- [ ] **Step 4: Run, verify all 5 cache-info tests pass**

Run: `nix develop --command npx vitest run tests/unit/cache-info.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup.mjs src/cache-info.ts tests/unit/cache-info.test.ts
git commit -m "Encode the cache pubkey as Wispy-PublicKey in nix-cache-info

Standard nix-cache-info has no public-key field; we add a custom one that
Nix ignores. Keeps the action's CI surface at exactly one secret + one var."
```

---

### Task 18: main.ts

**Files:**
- Create: `src/main.ts`

- [ ] **Step 1: Implement main.ts**

`src/main.ts`:

```typescript
import * as core from '@actions/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCacheInfo } from './cache-info.js';
import { parseInputs, type Inputs, type RawInputs } from './inputs.js';

// dist/main/index.js → action root is two dirs up.
const ACTION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readActionInputs(): RawInputs {
  return {
    'server-url': core.getInput('server-url'),
    token: core.getInput('token'),
  };
}

function runtimeDir(): string {
  const t = process.env.RUNNER_TEMP;
  if (!t) throw new Error('RUNNER_TEMP is not set');
  const dir = path.join(t, 'wispy');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeUserNixConf(dir: string, inputs: Inputs, publicKey: string, netrcPath: string, hookPath: string): string {
  const lines = [
    `extra-substituters = ${inputs.serverUrl}`,
    `extra-trusted-public-keys = ${publicKey}`,
    `netrc-file = ${netrcPath}`,
    `post-build-hook = ${hookPath}`,
  ];
  const confPath = path.join(dir, 'nix.conf');
  fs.writeFileSync(confPath, lines.join('\n') + '\n', { mode: 0o644 });
  return confPath;
}

function writeNetrc(dir: string, inputs: Inputs): string {
  const host = new URL(inputs.serverUrl).host;
  const body = `machine ${host} password ${inputs.token}\n`;
  const p = path.join(dir, 'netrc');
  fs.writeFileSync(p, body, { mode: 0o600 });
  return p;
}

function materializeHook(dir: string, inputs: Inputs, nixConfPath: string): string {
  const template = fs.readFileSync(path.join(ACTION_ROOT, 'scripts', 'hook.sh'), 'utf8');
  const rendered = template
    .replace(/__WISPY_NIX_CONF__/g, nixConfPath)
    .replace(/__WISPY_SERVER_URL__/g, inputs.serverUrl);
  const p = path.join(dir, 'hook.sh');
  fs.writeFileSync(p, rendered, { mode: 0o755 });
  return p;
}

function registerUserNixConf(confPath: string): void {
  const existing = process.env.NIX_USER_CONF_FILES ?? '';
  const chain = existing ? `${confPath}:${existing}` : confPath;
  core.exportVariable('NIX_USER_CONF_FILES', chain);
}

async function run(): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error(`wispy supports Linux runners only (got ${process.platform})`);
  }

  const inputs = parseInputs(readActionInputs());
  core.setSecret(inputs.token);

  const dir = runtimeDir();
  const info = await fetchCacheInfo(inputs.serverUrl);

  const netrc = writeNetrc(dir, inputs);
  const hookPath = path.join(dir, 'hook.sh');
  const conf = writeUserNixConf(dir, inputs, info.publicKey, netrc, hookPath);
  materializeHook(dir, inputs, conf);
  registerUserNixConf(conf);

  core.info(`wispy: configured substituter ${inputs.serverUrl} (StoreDir=${info.storeDir})`);
}

run().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.setFailed(`wispy setup failed: ${msg}`);
});
```

- [ ] **Step 2: Typecheck**

Run: `nix develop --command npx tsc -p tsconfig.action.json --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "Add action main: fetch cache-info, write nix.conf/netrc/hook, export env"
```

---

### Task 19: post.ts

**Files:**
- Create: `src/post.ts`

- [ ] **Step 1: Implement post.ts**

`src/post.ts`:

```typescript
import * as core from '@actions/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

function shred(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  try {
    const size = fs.statSync(filePath).size;
    fs.writeFileSync(filePath, Buffer.alloc(size, 0));
  } catch {
    // best-effort
  }
  fs.unlinkSync(filePath);
}

async function run(): Promise<void> {
  const t = process.env.RUNNER_TEMP;
  if (!t) return;
  const dir = path.join(t, 'wispy');
  if (!fs.existsSync(dir)) return;

  // The netrc holds the bearer token. Zero it before deletion.
  shred(path.join(dir, 'netrc'));

  // RUNNER_TEMP is cleaned by the runner; nothing else to do.
  core.info('wispy: cleaned up netrc');
}

run().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.warning(`wispy post step error: ${msg}`);
});
```

- [ ] **Step 2: Typecheck**

Run: `nix develop --command npx tsc -p tsconfig.action.json --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/post.ts
git commit -m "Add action post step: shred netrc"
```

---

### Task 20: action.yml

**Files:**
- Modify: `action.yml`

- [ ] **Step 1: Rewrite action.yml**

`action.yml`:

```yaml
name: 'wispy'
description: 'Serverless Nix binary cache: Cloudflare Worker fronts R2 and signs paths'
author: 'nicolaschan'
branding:
  icon: 'archive'
  color: 'orange'

inputs:
  server-url:
    description: 'wispy Worker URL (e.g. https://cache.user.workers.dev)'
    required: true
  token:
    description: 'Push-scoped JWT issued by scripts/issue-token.mjs'
    required: true

runs:
  using: 'node24'
  main: 'dist/main/index.js'
  post: 'dist/post/index.js'
```

- [ ] **Step 2: Commit**

```bash
git add action.yml
git commit -m "Update action.yml: 2 inputs (server-url, token), node24 runtime"
```

---

### Task 21: Build dist/ and verify

**Files:**
- Modify: `dist/main/`, `dist/post/`

- [ ] **Step 1: Run a clean build**

Run: `nix develop --command bash -c 'rm -rf dist/main dist/post && npm run build'`
Expected: emits `dist/main/index.js`, `dist/post/index.js`, plus sourcemaps and license files.

- [ ] **Step 2: Verify reproducibility**

Run: `nix develop --command npm run verify-dist`
Expected: `git diff --exit-code dist/` succeeds.

- [ ] **Step 3: Commit**

```bash
git add dist/
git commit -m "Build initial dist/ for v2 (main + post)"
```

---

## Phase 4: CI integration

### Task 22: Update CI workflow

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Update the workflow to run worker checks too**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [master]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: 'npm'
      - run: npm ci
      - name: Typecheck (action + worker)
        run: npm run typecheck
      - name: Lint
        run: npm run lint
      - name: Lint shell
        run: npm run lint:shell
      - name: Unit + worker tests
        run: npm test
      - name: Verify dist/ is up to date
        run: npm run verify-dist
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Update CI to typecheck both projects and run all tests"
```

---

### Task 23: Update integration workflow

**Files:**
- Modify: `.github/workflows/integration.yml`

- [ ] **Step 1: Rewrite integration.yml**

`.github/workflows/integration.yml`:

```yaml
name: integration
on:
  push:
    branches: [master]
  pull_request:

concurrency:
  group: integration-${{ github.ref }}
  cancel-in-progress: true

jobs:
  push:
    runs-on: ubuntu-latest
    outputs:
      out-path: ${{ steps.build.outputs.out-path }}
    env:
      WISPY_TEST_SALT: ${{ github.run_id }}-${{ github.run_attempt }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
      - run: npm ci
      - run: npm run build
      - uses: DeterminateSystems/nix-installer-action@main
      - name: Use wispy (this repo)
        uses: ./
        with:
          server-url: ${{ vars.WISPY_TEST_SERVER_URL }}
          token: ${{ secrets.WISPY_TEST_PUSH_TOKEN }}
      - id: build
        name: Build salted test derivation
        env:
          WISPY_TEST_SALT: ${{ env.WISPY_TEST_SALT }}
        run: |
          OUT=$(nix build --print-out-paths --impure ./tests#default)
          echo "out-path=$OUT" >> "$GITHUB_OUTPUT"
          echo "Built: $OUT"
      - name: Wait for upload to settle
        run: sleep 5

  pull:
    needs: push
    runs-on: ubuntu-latest
    env:
      WISPY_TEST_SALT: ${{ github.run_id }}-${{ github.run_attempt }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
      - run: npm ci
      - run: npm run build
      - uses: DeterminateSystems/nix-installer-action@main
      - name: Use wispy (this repo)
        uses: ./
        with:
          server-url: ${{ vars.WISPY_TEST_SERVER_URL }}
          token: ${{ secrets.WISPY_TEST_PULL_TOKEN }}
      - name: Build the same salted derivation; assert it was substituted
        run: |
          OUT="${{ needs.push.outputs.out-path }}"
          echo "Expecting substitution of: $OUT"
          nix build --max-jobs 0 --impure ./tests#default
          ACTUAL=$(nix build --print-out-paths --impure ./tests#default)
          test "$ACTUAL" = "$OUT" || { echo "store path mismatch"; exit 1; }
          echo "OK: $OUT substituted from cache"
```

> The operator must pre-deploy a test cache and create three GitHub Actions secrets/vars:
>   - `vars.WISPY_TEST_SERVER_URL` — the deployed Worker URL
>   - `secrets.WISPY_TEST_PUSH_TOKEN` — JWT with scope=push
>   - `secrets.WISPY_TEST_PULL_TOKEN` — JWT with scope=pull (used here even though v1 has public reads, so push doesn't accidentally pass with the pull token)
>
> The previous integration setup vars (`WISPY_TEST_R2_BUCKET`, `WISPY_TEST_R2_ACCOUNT_ID`, the two R2 keys, signing keys) can be deleted from the repo settings after the migration is verified.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/integration.yml
git commit -m "Rewrite integration workflow to use the Worker (2 inputs only)"
```

---

### Task 24: Update README + example workflow

**Files:**
- Modify: `README.md`, `examples/basic.yml`

- [ ] **Step 1: Rewrite README.md**

```markdown
# wispy

A serverless Nix binary cache: a Cloudflare Worker fronts R2 and signs
paths server-side, and a GitHub Action sets up Nix to push and pull
against it.

CI surface per repo: **one secret + one variable**.

## Quick start

```bash
# Operator's machine, one-time per cache
git clone https://github.com/nicolaschan/wispy && cd wispy
nix develop
wrangler login
node scripts/setup.mjs --cache mycache --bucket wispy-mycache
wrangler deploy --config worker/wrangler.toml
node scripts/issue-token.mjs --cache mycache --scope push | gh secret set WISPY_TOKEN
gh variable set WISPY_SERVER_URL --body "https://wispy.<account>.workers.dev"
```

In a consuming workflow:

```yaml
- uses: DeterminateSystems/nix-installer-action@main
- uses: nicolaschan/wispy@v2
  with:
    server-url: ${{ vars.WISPY_SERVER_URL }}
    token:      ${{ secrets.WISPY_TOKEN }}
```

That's it. Builds in the runner's nix-daemon are pushed automatically
via `post-build-hook`; subsequent builds substitute from the cache.

## Design

See [`docs/superpowers/specs/2026-05-23-serverless-attic-worker-design.md`](docs/superpowers/specs/2026-05-23-serverless-attic-worker-design.md).
```

- [ ] **Step 2: Rewrite examples/basic.yml**

```yaml
name: build
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DeterminateSystems/nix-installer-action@main
      - uses: nicolaschan/wispy@v2
        with:
          server-url: ${{ vars.WISPY_SERVER_URL }}
          token:      ${{ secrets.WISPY_TOKEN }}
      - run: nix build
```

- [ ] **Step 3: Commit**

```bash
git add README.md examples/basic.yml
git commit -m "Update README + example workflow for v2 (one secret + one var)"
```

---

### Task 25: Final clean build + full test run

- [ ] **Step 1: Clean build**

Run: `nix develop --command bash -c 'rm -rf dist/main dist/post node_modules && npm ci && npm run build'`
Expected: clean install + build, no errors.

- [ ] **Step 2: Full check**

Run: `nix develop --command bash -c 'npm run typecheck && npm run lint && npm run lint:shell && npm run test && npm run verify-dist'`
Expected: all green.

- [ ] **Step 3: Commit any dist changes**

```bash
git add dist/
git diff --cached --stat
# If empty, skip the commit.
git commit -m "Rebuild dist/ after final wiring" || true
```

- [ ] **Step 4: Open PR**

Run:

```bash
git push -u origin serverless-attic
gh pr create \
  --title "Wispy v2: serverless attic on Workers + R2" \
  --body "$(cat <<'EOF'
## Summary

- Replaces the v1 s3-direct implementation with a Cloudflare Worker that fronts R2 and signs Nix paths server-side.
- Action CI surface collapses to one secret (`token`) + one variable (`server-url`).
- Standard Nix HTTPS cache protocol on both push and pull; the Worker rewrites client-uploaded narinfos to add a server signature.
- All tooling provided by the flake devShell — only `nix` need be preinstalled.

## Spec

`docs/superpowers/specs/2026-05-23-serverless-attic-worker-design.md`

## Test plan

- [ ] CI passes (typecheck, lint, unit + worker integration, verify-dist)
- [ ] Manual: `node scripts/setup.mjs` against a real Cloudflare account
- [ ] Manual: `wrangler deploy` and full integration workflow round-trip

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-review checklist

After completing the plan, before invoking execution:

- [ ] Spec coverage:
  - One-secret + one-var CI surface — Task 15 (inputs), Task 18 (main), Task 20 (action.yml). ✓
  - Server-side signing — Task 7 (sign.ts), Task 10 (handler). ✓
  - Standard Nix HTTPS protocol — Task 10 (PUT handlers). ✓
  - User-level nix.conf via NIX_USER_CONF_FILES — Task 18 (main.ts). ✓
  - Flake-provided tooling — Task 1 (devShell). ✓
  - Single-cache for v1 — wrangler.toml is single-cache (Task 5); no path routing in handlers (Task 10). ✓
  - No DB, no chunking, no GC — design holds; nothing in the plan adds them. ✓
  - Setup script — Task 14. ✓
  - Token issuance script — Task 13. ✓
  - Pubkey discovery via Wispy-PublicKey — Task 17 (spec gap surfaced and patched). ✓

- [ ] Placeholders: scanned. No "TBD" / "implement later". Two manual-only steps (setup smoke test in Task 14, integration deploy in Task 23) are noted as such with explicit operator instructions, not as TODOs for the implementation.

- [ ] Type consistency: `SigningKey` shape consistent between sign.ts (Task 7) and parseSigningKey in index.ts (Task 10). `Narinfo` consistent between narinfo.ts (Task 6) and handlers. `Inputs.serverUrl` (camelCase) used in main.ts (Task 18) matches inputs.ts (Task 15). ✓
