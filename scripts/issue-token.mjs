#!/usr/bin/env node
// Mint a wispy JWT from the local jwt.secret that setup.mjs wrote.
// Reads --cache <name> to locate ~/.wispy/<name>/jwt.secret.
// Emits the JWT to stdout.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import { issueToken } from '../worker/src/auth.ts';

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
