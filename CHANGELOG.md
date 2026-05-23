# Changelog

## v0.1.0 — unreleased

Initial release.

- Push: async post-build-hook + detached uploader, parallel `nix copy` to R2.
- Pull: Nix native `s3://` substituter with R2 endpoint.
- Signing: user-provided keypair, daemon signs at build time.
- `skip-push` input for PRs from forks.
- Linux x86_64 / aarch64 only.
