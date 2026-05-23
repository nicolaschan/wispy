# wispy

Drop-in GitHub Action that caches Nix builds on a private Cloudflare R2
bucket. Push side runs as a detached background uploader so the build's
critical path isn't blocked on object storage; pull side is configured
through Nix's native `s3://` substituter.

## Quick start

```yaml
- uses: DeterminateSystems/nix-installer-action@main
- uses: nicolaschan/wispy@v1
  with:
    r2-bucket:            ${{ vars.WISPY_R2_BUCKET }}
    r2-account-id:        ${{ vars.WISPY_R2_ACCOUNT_ID }}
    r2-access-key-id:     ${{ secrets.WISPY_R2_ACCESS_KEY_ID }}
    r2-secret-access-key: ${{ secrets.WISPY_R2_SECRET_ACCESS_KEY }}
    signing-private-key:  ${{ secrets.WISPY_SIGNING_PRIVATE_KEY }}
    signing-public-key:   ${{ vars.WISPY_SIGNING_PUBLIC_KEY }}
- run: nix build .#default
```

See [`examples/basic.yml`](examples/basic.yml) for a complete workflow.

## One-time setup

1. **Generate a signing keypair.** Each cache needs its own ed25519
   keypair. Generate it locally once:

   ```sh
   nix-store --generate-binary-cache-key \
     "wispy-$(whoami)-1" /tmp/wispy.priv /tmp/wispy.pub
   ```

2. **Add the keys to GitHub.**
   - **Secret** `WISPY_SIGNING_PRIVATE_KEY` ← contents of `/tmp/wispy.priv`
   - **Variable** `WISPY_SIGNING_PUBLIC_KEY` ← contents of `/tmp/wispy.pub`
     (Public key is a Variable, not a Secret, so it appears unredacted
     in logs — useful for debugging substituter trust.)

3. **Create an R2 bucket and API token.** In the Cloudflare dashboard
   (or via `wrangler`):
   - Create a bucket (e.g. `wispy-cache`). Keep it private.
   - Create an R2 API token scoped to "Object Read & Write" on that
     bucket only.
   - Add to GitHub:
     - **Secret** `WISPY_R2_ACCESS_KEY_ID`
     - **Secret** `WISPY_R2_SECRET_ACCESS_KEY`
     - **Variable** `WISPY_R2_BUCKET` (the bucket name)
     - **Variable** `WISPY_R2_ACCOUNT_ID` (the Cloudflare account ID)

4. **Add the action** before your `nix build` step (see Quick start).

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `r2-bucket` | yes | — | R2 bucket name. |
| `r2-account-id` | yes | — | Cloudflare account ID. |
| `r2-access-key-id` | yes | — | R2 API token's access key ID. |
| `r2-secret-access-key` | yes | — | R2 API token's secret. |
| `signing-private-key` | yes | — | Full contents of the ed25519 private key file. |
| `signing-public-key` | yes | — | Public key (e.g. `wispy-foo-1:abc...=`). |
| `upload-concurrency` | no | `8` | Max parallel `nix copy` invocations. |
| `extra-substituters` | no | `https://cache.nixos.org/` | Merged into nix.conf. |
| `extra-trusted-public-keys` | no | (cache.nixos.org key) | Merged into nix.conf. |
| `skip-push` | no | `false` | If `true`, configure pull only. Use for PRs from forks. |

## Outputs

| Output | Description |
| --- | --- |
| `paths-pushed` | Unique store paths uploaded to R2 in this run. |
| `bytes-pushed` | Sum of compressed NAR bytes uploaded. |
| `paths-failed` | Paths that failed to upload (does not fail the build). |

## FAQ

### What's actually cached?

Only paths that this run **builds locally**. Paths that Nix substitutes
from `cache.nixos.org` are not re-uploaded — there's no point in
mirroring upstream content into your private cache (use the future
`wispy` Worker for that). If you want a path to land in R2, the build
must produce it.

### How do PRs from forks work?

Forks can't read your repo's secrets, so they can't push to your cache.
Set `skip-push` based on the event:

```yaml
- uses: nicolaschan/wispy@v1
  with:
    skip-push: ${{ github.event.pull_request && github.event.pull_request.head.repo.fork }}
    # ...other inputs
```

This configures the pull side (so the fork's CI still benefits from
cache hits) and skips wiring the post-build-hook (so the fork can't
poison the cache).

### Why isn't my build using the cache?

- Check the action's log for the line `wispy uploader started (pid=...)`.
  If absent, the signing/key/credentials config is wrong.
- Check that the same `signing-public-key` is configured on both writer
  and reader runs. A mismatch means signed paths are rejected.
- Check `paths-pushed` output > 0 on the writer run.

### Platform support

Linux x86_64 and aarch64 only in v1. macOS support requires a different
nix-daemon reload path (launchd) and is deferred. The action fails fast
with a clear message on non-Linux runners.

### Roadmap

v1 caches directly to R2 over the S3 protocol. v2 will introduce a
Cloudflare Worker that fronts R2 with smarter caching (upstream
mirroring of `cache.nixos.org`, namespacing, GC, metrics). The
migration is a one-line change for users: swap the `extra-substituters`
URL.

## License

MIT.
