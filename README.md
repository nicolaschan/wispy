# wispy

A serverless Nix binary cache: a Cloudflare Worker fronts R2 and signs
paths server-side, and a GitHub Action sets up Nix to push and pull
against it.

CI surface per repo: **one secret + one variable**.

## Quick start

Operator's machine, one-time per cache (assumes only `nix` preinstalled):

```bash
git clone https://github.com/nicolaschan/wispy && cd wispy
nix develop                                    # provides node, wrangler, gh, jq
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

## How it works

```
┌── GitHub Actions ─────────────────────────────────┐
│  uses: nicolaschan/wispy@v2                       │
└──────────────┬────────────────────────────────────┘
               │ HTTPS, bearer JWT in netrc
               ▼
┌── Cloudflare Worker (one cache) ──────────────────┐
│  GET  /nix-cache-info                             │
│  GET  /<hash>.narinfo                             │
│  GET  /nar/<filehash>.nar.zst                     │
│  PUT  /<hash>.narinfo       (auth, sign + store)  │
│  PUT  /nar/<filehash>.nar.zst (auth, store)       │
└──────────────┬────────────────────────────────────┘
               │ R2 binding
               ▼
┌── R2 Bucket ──────────────────────────────────────┐
│  nix-cache-info / <hash>.narinfo / nar/...        │
└───────────────────────────────────────────────────┘
```

- The Worker holds the ed25519 signing key as a Workers Secret. CI never
  sees it.
- The Worker authenticates PUTs with HS256 JWTs signed by a root secret
  (also a Workers Secret). The action gets the JWT through `netrc-file`,
  not via environment variables.
- The action discovers the cache's public key at runtime by fetching
  `/nix-cache-info`, which encodes it as a `Wispy-PublicKey` line. No
  extra inputs.
- Pushes use the standard Nix HTTPS binary cache PUT protocol
  (`nix copy --to https://worker/`). The Worker rewrites the
  client-supplied narinfo to add the server signature before storing.

See [`docs/superpowers/specs/2026-05-23-serverless-attic-worker-design.md`](docs/superpowers/specs/2026-05-23-serverless-attic-worker-design.md)
for the full design.

## Repo layout

```
worker/    Cloudflare Worker source + wrangler.toml
src/       GitHub Action (Node 24)
scripts/   setup.mjs, issue-token.mjs, hook.sh
tests/     vitest unit + worker integration tests
```

## Development

```bash
nix develop
npm ci
npm test           # vitest, all tests
npm run typecheck  # action + worker tsconfigs
npm run lint
npm run build      # rebuild dist/main + dist/post
```

## License

MIT
