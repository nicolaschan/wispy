#!/usr/bin/env bash
# wispy post-build-hook: invoked by nix-daemon after every built derivation.
# Generated from scripts/hook.sh by wispy setup; the placeholder
# __WISPY_QUEUE_FILE__ is replaced with the absolute path to the queue file.
#
# Never fail: the build must succeed regardless of cache state.
set -u
printf '%s\n' "$OUT_PATHS" >> '__WISPY_QUEUE_FILE__' 2>/dev/null || true
