#!/usr/bin/env bash
# wispy post-build-hook. nix-daemon fires this with OUT_PATHS set to the
# (space-separated) store paths just built. We push to the configured
# wispy Worker via standard `nix copy`. The Worker authenticates and signs.
#
# Placeholders __WISPY_NIX_BIN__, __WISPY_NIX_CONF__, and __WISPY_SERVER_URL__
# are substituted by src/main.ts when the action materializes this file.
#
# __WISPY_NIX_BIN__ is the absolute path to the `nix` binary captured at
# action-run time. The daemon's PATH may not contain it, which would cause
# exec to fail with "command not executable" (exit 126).
#
# NIX_USER_CONF_FILES is re-exported explicitly because the daemon does not
# propagate the action's environment to spawned hooks.
set -u
export NIX_USER_CONF_FILES="__WISPY_NIX_CONF__"
# shellcheck disable=SC2086  # OUT_PATHS is space-separated and must word-split
exec "__WISPY_NIX_BIN__" copy --to "__WISPY_SERVER_URL__" $OUT_PATHS
