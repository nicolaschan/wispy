import * as core from '@actions/core';
import { getExecOutput } from '@actions/exec';
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

function writeUserNixConf(
  dir: string,
  inputs: Inputs,
  publicKey: string,
  netrcPath: string,
  hookPath: string,
): string {
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

async function resolveNixBin(): Promise<string> {
  // The daemon spawns the hook with a minimal PATH that may not include
  // nix. Resolve the absolute path now (where PATH does include it) and
  // bake it into the hook script. Use `which` (a real binary), not the
  // bash builtin `command -v` — @actions/exec needs an executable.
  const { stdout } = await getExecOutput('which', ['nix'], { silent: true });
  const nixBin = stdout.trim();
  if (!nixBin) throw new Error('could not locate `nix` on PATH');
  return nixBin;
}

function materializeHook(dir: string, inputs: Inputs, nixConfPath: string, nixBin: string): string {
  const template = fs.readFileSync(path.join(ACTION_ROOT, 'scripts', 'hook.sh'), 'utf8');
  const rendered = template
    .replace(/__WISPY_NIX_BIN__/g, nixBin)
    .replace(/__WISPY_NIX_CONF__/g, nixConfPath)
    .replace(/__WISPY_SERVER_URL__/g, inputs.serverUrl);
  const p = path.join(dir, 'hook.sh');
  fs.writeFileSync(p, rendered, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
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
  const nixBin = await resolveNixBin();

  const netrc = writeNetrc(dir, inputs);
  const hookPath = path.join(dir, 'hook.sh');
  const conf = writeUserNixConf(dir, inputs, info.publicKey, netrc, hookPath);
  materializeHook(dir, inputs, conf, nixBin);
  registerUserNixConf(conf);

  core.info(`wispy: configured substituter ${inputs.serverUrl} (StoreDir=${info.storeDir}, nix=${nixBin})`);
}

run().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.setFailed(`wispy setup failed: ${msg}`);
});
