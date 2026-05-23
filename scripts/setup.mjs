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
// `r2 bucket create` always targets real R2; there is no local equivalent
// (unlike `r2 object put`, which defaults to local and needs --remote).
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

// 6. Upload nix-cache-info. Includes Wispy-PublicKey so the action can
// discover it without an extra input. --remote is required; without it
// wrangler puts the object in the local sandbox and the deployed worker
// returns 500 because real R2 is empty.
const cacheInfo =
  `StoreDir: /nix/store\n` +
  `WantMassQuery: 1\n` +
  `Priority: 30\n` +
  `Wispy-PublicKey: ${pubNix}\n`;
const tmpInfoPath = join(wispyDir, 'nix-cache-info');
writeFileSync(tmpInfoPath, cacheInfo);
run('wrangler', ['r2', 'object', 'put', `${args.bucket}/nix-cache-info`, '--file', tmpInfoPath, '--content-type', 'text/x-nix-cache-info', '--remote']);

// 7. Upload secrets.
console.log('uploading SIGNING_PRIVATE_KEY...');
runWithStdin('wrangler', ['secret', 'put', 'SIGNING_PRIVATE_KEY', '--config', 'worker/wrangler.toml'], privNix);

console.log('uploading JWT_ROOT_SECRET...');
runWithStdin('wrangler', ['secret', 'put', 'JWT_ROOT_SECRET', '--config', 'worker/wrangler.toml'], jwtSecret);

console.log('\nsetup complete. next:');
console.log('  wrangler deploy --config worker/wrangler.toml');
console.log(`  node scripts/issue-token.mjs --cache ${args.cache} --scope push`);
