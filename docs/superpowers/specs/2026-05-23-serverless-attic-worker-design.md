# Wispy v2: serverless attic on Cloudflare Workers + R2

Date: 2026-05-23
Status: design, pending implementation
Replaces: the current `impl/v1` shape (s3-direct from CI to R2)

## Problem

The v1 action wires CI directly to R2 via the S3 protocol. That works,
but the trust surface on every consuming workflow is too wide:

- `r2-bucket`, `r2-account-id`, `r2-access-key-id`, `r2-secret-access-key`,
  `signing-private-key`, `signing-public-key` — four secrets and two
  variables per repo, all directly granting access to the underlying R2
  bucket and the cache's signing identity.
- The signing private key sits on every CI runner that pushes, multiplying
  the number of places it can leak.
- Setting up a new repo means provisioning all of those secrets, which is
  the friction that motivated this redesign.

The fix is to move all of that into a single Cloudflare Worker that
fronts R2 and owns the signing key. CI only needs a single scoped JWT
and the Worker's URL.

## Goals

- One secret in CI (a JWT) plus one variable (the Worker URL).
- Server-side signing: the Nix signing private key lives in Cloudflare
  Workers Secrets and never reaches a CI runner.
- Standard Nix HTTPS binary cache protocol on both push and pull, so
  the consumer side is stock `nix copy` / substituter behavior.
- Everything reproducible from `nix develop`. The flake's devShell
  provides every non-`nix` tool the project needs.
- Single-cache per Worker for v1. Multi-cache (attic-style path
  prefixes) is a v2 concern, but the shape today should not foreclose
  on it.

## Non-goals (v1)

- Multi-cache routing on a single Worker.
- Content-defined chunking / cross-path deduplication.
- A metadata database (Postgres, D1) — narinfo is stored as R2 objects
  directly.
- Garbage collection. The cache grows until the operator prunes R2
  manually or applies an R2 lifecycle rule.
- A separate pull-side auth gate. v1 ships with public reads; pull JWT
  enforcement is an opt-in flag for a later iteration.

## Architecture

```
┌── GitHub Actions ─────────────────────────────────┐
│  uses: nicolaschan/wispy@v2                       │
│  with:                                            │
│    server-url: ${{ vars.WISPY_SERVER_URL }}       │
│    token:      ${{ secrets.WISPY_TOKEN }}         │
└──────────────┬────────────────────────────────────┘
               │ HTTPS, bearer JWT in netrc
               ▼
┌── Cloudflare Worker (one cache) ──────────────────┐
│  GET  /nix-cache-info       (public)              │
│  GET  /<hash>.narinfo       (public)              │
│  GET  /nar/<filehash>.nar.zst (public, streams)   │
│  PUT  /<hash>.narinfo       (auth, sign + store)  │
│  PUT  /nar/<filehash>.nar.zst (auth, store)       │
│                                                   │
│  Secrets: SIGNING_PRIVATE_KEY, JWT_ROOT_SECRET    │
└──────────────┬────────────────────────────────────┘
               │ R2 binding
               ▼
┌── R2 Bucket ──────────────────────────────────────┐
│  nix-cache-info                                   │
│  <hash>.narinfo                                   │
│  nar/<filehash>.nar.zst                           │
└───────────────────────────────────────────────────┘
```

The CI surface is exactly one secret (`token`) and one variable
(`server-url`). The public key isn't a CI input — the action fetches
`/nix-cache-info` on startup and reads the pubkey from there.

## Components

### Worker (`worker/src/`)

| File          | Purpose                                                            |
|---------------|--------------------------------------------------------------------|
| `index.ts`    | HTTP router + auth middleware                                      |
| `narinfo.ts`  | Parse and serialize the Nix `.narinfo` key:value text format       |
| `sign.ts`     | ed25519 signing over Nix's "fingerprint" string                    |
| `auth.ts`     | HS256 JWT verify (constant-time), scope check                      |
| `r2.ts`       | Thin wrapper around the R2 binding for `get`/`put`/`head`          |

Single dispatch table, five routes. No database, no queues. The
Worker is request/response with no asynchronous side effects.

### Action (`src/`)

| File             | Purpose                                                  |
|------------------|----------------------------------------------------------|
| `main.ts`        | Setup user-level nix.conf, fetch pubkey, materialize hook |
| `post.ts`        | Shred netrc, dump nix copy log                            |
| `inputs.ts`      | Parse two inputs: `server-url`, `token`                   |
| `cache-info.ts`  | `GET /nix-cache-info` and extract the public key          |

The current v1 surface (`uploader.ts`, `queue.ts`, `contract.ts`,
plus the systemd drop-in and AWS env wiring) is removed. `dist/uploader/`
goes away entirely.

### Scripts (`scripts/`)

| File                  | Purpose                                                            |
|-----------------------|--------------------------------------------------------------------|
| `setup.mjs`           | One-shot setup: keygen, R2 bucket, secrets, `nix-cache-info` upload |
| `issue-token.mjs`     | Mint a JWT given `JWT_ROOT_SECRET` in env                          |
| `hook.sh.template`    | The `post-build-hook` script with placeholders                     |

These run from `nix develop` and assume no globally-installed tools
beyond `nix` itself.

## Push protocol

CI sets up `nix.conf` (via `NIX_USER_CONF_FILES`, the cachix pattern
already proven in v1) with:

```
extra-substituters = https://cache.example.com
extra-trusted-public-keys = <fetched from /nix-cache-info>
netrc-file = /tmp/wispy/netrc
post-build-hook = /tmp/wispy/hook.sh
```

The netrc file contains `machine cache.example.com password <JWT>`.
There is **no** `secret-key-files` setting — the client does not sign;
the server does.

The hook script (generated, placeholders substituted) is:

```bash
#!/usr/bin/env bash
export NIX_USER_CONF_FILES="__WISPY_NIX_CONF__"
exec nix copy --to "__WISPY_SERVER_URL__" $OUT_PATHS
```

The explicit `export` is necessary because the nix-daemon spawns the
hook without inheriting the user's environment.

The data flow on a successful build:

```
1. nix builds /nix/store/abc...
2. nix-daemon fires post-build-hook with OUT_PATHS=/nix/store/abc...
3. Hook calls: nix copy --to https://cache.example.com /nix/store/abc...
4. nix copy:
     a. Locally reads the path's narinfo (no Sig line, no signing configured)
     b. zstd-compresses the NAR stream
     c. PUT /<hash>.narinfo + PUT /nar/<filehash>.nar.zst
        Bearer auth from netrc-file
5. Worker authenticates JWT (scope=push), parses narinfo, signs with
   SIGNING_PRIVATE_KEY, writes signed narinfo + NAR to R2
6. Hook exits 0; build continues
```

### Why standard PUT instead of a custom upload endpoint

Attic uses `POST /api/v1/upload-path` with NAR + JSON path-info. We
considered the same shape but the standard Nix HTTPS cache PUT
protocol is strictly simpler for our case:

- Client side is stock `nix copy --to https://...` — no custom uploader,
  no queue file, no daemon contract to maintain.
- The narinfo is small text; parsing and re-serializing it on the Worker
  is trivial.
- The signature attests to narinfo contents; consumers verify NarHash
  against the actual NAR they download. A lying client produces broken
  paths in the cache but cannot trick consumers, which is the same trust
  property as today's client-side signing.

We give up the server-side ability to reject mismatched metadata before
storing. That's an acceptable cost for v1 in exchange for losing all
custom client code.

## Pull protocol

Standard Nix HTTPS binary cache substituter. No special action work on
the consumer side beyond setting `substituters` and
`trusted-public-keys` (the latter retrieved by fetching
`/nix-cache-info`, which the action already does for the same workflow
that pushed).

```
1. nix needs /nix/store/abc...
2. nix-daemon: GET https://cache.example.com/<hash>.narinfo
3. Worker streams from R2 (no auth required for public reads in v1)
4. nix-daemon verifies sig against trusted-public-keys
5. nix-daemon: GET /nar/<filehash>.nar.zst
6. nix-daemon decompresses, places in store
```

## Auth model

```
Token: HS256 JWT, signed with JWT_ROOT_SECRET (Workers Secret)

Claims:
  scope: "push" | "pull"
  iat:   <unix seconds>
  exp:   <unix seconds, optional>
```

The Worker verifies HMAC-SHA256 over `header.payload`, constant-time
compares, checks scope against the operation (push for PUT, pull for
GET if pull-gating is on), and rejects expired tokens.

No `iss`, `sub`, or `aud` in v1. When multi-cache lands, `sub:
<cache-name>` slots in naturally and `iss` becomes the Worker's hostname.

### Token issuance

Local-only. Cloudflare Workers Secrets are write-only — once uploaded
they can't be read back — so the JWT root secret must also live on the
operator's machine to mint new tokens. `setup.mjs` writes it to
`~/.wispy/<cache-name>/jwt.secret` with mode 0600 at the same time it
calls `wrangler secret put JWT_ROOT_SECRET`. The two copies are the
same byte string and must stay in sync; rotating the secret means
overwriting both.

```bash
node scripts/issue-token.mjs \
  --cache mycache \
  --scope push \
  --expires 90d
# reads ~/.wispy/mycache/jwt.secret, emits JWT to stdout
```

No admin endpoint on the Worker. Token minting requires holding the
root secret on the user's machine, which is the same trust as
`wrangler secret put` itself.

## R2 layout

```
<bucket>/
  nix-cache-info               # generated by setup.mjs, contains StoreDir + Sig pubkey
  <hash>.narinfo               # one per cached path (rewritten by Worker to add Sig)
  nar/<filehash>.nar.zst       # NAR blob, content-addressed by filehash
```

Flat. No per-cache prefix because v1 is single-cache. When multi-cache
lands, `<cache>/...` becomes the prefix.

## Repo layout

```
wispy/
├── flake.nix
├── flake.lock
├── action.yml
├── dist/
│   ├── main/index.js
│   └── post/index.js
├── src/
│   ├── main.ts
│   ├── post.ts
│   ├── inputs.ts
│   └── cache-info.ts
├── worker/
│   ├── src/
│   │   ├── index.ts
│   │   ├── narinfo.ts
│   │   ├── sign.ts
│   │   ├── auth.ts
│   │   └── r2.ts
│   ├── wrangler.toml
│   ├── package.json
│   └── tsconfig.json
├── scripts/
│   ├── setup.mjs
│   ├── issue-token.mjs
│   └── hook.sh.template
├── tests/
│   ├── unit/
│   ├── worker/
│   └── fixtures/
├── package.json
└── README.md
```

## Flake contract

After `nix develop`, this list of tools must be available on a machine
that has only `nix` installed. No `npm i -g`, no `brew install`, no
preinstalled wrangler.

| Tool         | Used by                                     | nixpkgs attribute       |
|--------------|---------------------------------------------|-------------------------|
| node, npm    | Build, tests, scripts, wrangler internals   | `nodejs_24`             |
| wrangler     | Worker deploy, R2 bucket, secret put        | `nodePackages.wrangler` |
| gh           | `gh secret set`, `gh variable set`          | `gh`                    |
| shellcheck   | Lint `scripts/hook.sh.template`             | `shellcheck`            |
| jq           | JSON munging in setup script                | `jq`                    |
| git          | Setup, CI                                   | `git`                   |

CI may continue to use `actions/setup-node@v4` (faster, cached) or run
inside `nix develop --command` (more reproducible). Both are acceptable;
the design does not mandate either.

## Setup UX

One-time, on the operator's machine:

```bash
# 1. Clone + auth + flake shell
git clone https://github.com/nicolaschan/wispy && cd wispy
nix develop
wrangler login

# 2. Generate keys and provision the cache
node scripts/setup.mjs --cache mycache --bucket wispy-mycache
#   → generates an ed25519 keypair
#   → generates a 32-byte JWT_ROOT_SECRET
#   → writes ~/.wispy/mycache/ with: signing-private-key, signing-public-key,
#     jwt.secret (all mode 0600), plus wrangler.toml fragment
#   → creates the R2 bucket via wrangler
#   → uploads a nix-cache-info object to R2 (StoreDir, pubkey, compression)
#   → calls `wrangler secret put SIGNING_PRIVATE_KEY` and
#     `wrangler secret put JWT_ROOT_SECRET`, piping from the local files

# 3. Deploy
wrangler deploy

# 4. Mint a CI token
node scripts/issue-token.mjs --cache mycache --scope push > /tmp/wispy.token
gh secret set WISPY_TOKEN < /tmp/wispy.token
gh variable set WISPY_SERVER_URL \
  --body "https://wispy-mycache.<account>.workers.dev"
```

In the consuming workflow:

```yaml
- uses: DeterminateSystems/nix-installer-action@main
- uses: nicolaschan/wispy@v2
  with:
    server-url: ${{ vars.WISPY_SERVER_URL }}
    token:      ${{ secrets.WISPY_TOKEN }}
```

## Error handling

| Scenario                                  | Behavior                                                                                       |
|-------------------------------------------|------------------------------------------------------------------------------------------------|
| Invalid or missing JWT on PUT             | 401, body `{error: "unauthorized"}`                                                            |
| JWT scope=pull on a PUT                   | 403                                                                                            |
| Malformed narinfo body                    | 400 with parse error message                                                                   |
| R2 PUT fails                              | 502; `nix copy` retries via its existing retry loop                                            |
| R2 GET miss on `.narinfo`                 | 404; nix treats as cache miss                                                                  |
| R2 GET miss on `.nar.zst` after narinfo hit | 502 with a log line — this is a corrupted cache signal worth surfacing                       |
| Concurrent PUTs of same path              | Last writer wins. Narinfo content is deterministic per path so this is benign                  |
| Hook can't reach the Worker (network down)| `nix copy` returns nonzero; the build still succeeds (Nix logs the failure but does not abort) |

No retries inside the Worker. No queue, no dead-letter, no async — the
Worker handles request/response only.

## Testing

| Layer                  | Approach                                                                                                  |
|------------------------|-----------------------------------------------------------------------------------------------------------|
| `narinfo.ts`           | Vitest unit tests against fixtures pulled from a real Nix store                                           |
| `sign.ts`              | Golden tests with a fixed key; output must reproduce what `nix store sign` produces                       |
| `auth.ts`              | Sign + verify roundtrip, expiry, scope, constant-time compare                                             |
| Worker integration     | `wrangler dev --local` + a harness that PUTs fake narinfo + NAR, GETs them back, runs `nix copy --from` against the local Worker |
| End-to-end             | Existing-style integration workflow: ephemeral Worker per CI run, push a salted derivation, pull it in a second job with `--max-jobs 0` |

The signing golden test is the load-bearing one: bug in `sign.ts` and
the entire cache silently fails to verify for consumers.

## Replacing v1

The v1 implementation has merged to master but no release has been
tagged. There are no consumers depending on the v1 action shape.

Plan:

1. New branch `serverless-attic` off the current master.
2. Delete the v1 src/, dist/, scripts/, tests/ that don't apply.
3. Implement the design on this branch.
4. New PR against master, replacing the current implementation.
5. After merge, tag v2.0.0 (or v1.0.0, since v1 was unreleased — naming
   to be decided at release time).

No migration code, no compatibility shims. v1 is a learning step that
informed v2; the codebase moves wholesale.

## Open questions

- Pull-side auth: ship v1 with public reads (current plan), or with
  pull JWT enforcement on by default and an opt-out flag? Public reads
  match "treat the cache like a CDN" and avoid the operational
  complication of distributing pull tokens to every consumer. Default
  to public for v1, revisit if a real private-cache need surfaces.

- Compression: `nix copy --to` chooses the compression based on the
  destination's `nix-cache-info` (`Compression: zstd|xz|none`). We
  publish `Compression: zstd` in our `nix-cache-info`. The Worker
  passes the body through to R2 unchanged.

- R2 lifecycle / GC: out of scope for v1. The operator can apply an R2
  lifecycle rule (e.g., delete objects older than 90 days) if they want
  bounded storage cost. v2 may add an explicit `nix-store --gc`-aware
  cleanup endpoint.
