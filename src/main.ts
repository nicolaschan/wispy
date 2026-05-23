import * as core from '@actions/core';
import { exec } from '@actions/exec';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serializeUploaderEnv } from './contract.js';
import { parseInputs, type Inputs, type RawInputs } from './inputs.js';
import {
  DAEMON_DROPIN_PATH,
  makeRuntimePaths,
  writeSystemFileViaSudo,
  type RuntimePaths,
} from './paths.js';
import { buildSubstituterUrl, smokeTestBucket } from './r2.js';

function readActionInputs(): RawInputs {
  const keys = [
    'r2-bucket',
    'r2-account-id',
    'r2-access-key-id',
    'r2-secret-access-key',
    'signing-private-key',
    'signing-public-key',
    'upload-concurrency',
    'extra-substituters',
    'extra-trusted-public-keys',
    'skip-push',
  ];
  const raw: RawInputs = {};
  for (const k of keys) raw[k] = core.getInput(k);
  return raw;
}

// The bundled entry ships at <action-root>/dist/main/index.js, so the action
// checkout root is two directories up. GITHUB_ACTION_PATH would be cleaner
// but the runner only sets it for composite actions, not node20 actions.
const ACTION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function buildUserNixConf(inputs: Inputs, paths: RuntimePaths, destUrl: string): string {
  const lines = [
    `extra-substituters = ${destUrl} ${inputs.extraSubstituters.join(' ')}`.trim(),
    `extra-trusted-public-keys = ${inputs.signingPublicKey} ${inputs.extraTrustedPublicKeys.join(' ')}`.trim(),
  ];
  if (!inputs.skipPush) {
    lines.push(`secret-key-files = ${paths.signingKey}`);
    lines.push(`post-build-hook = ${paths.hook}`);
  }
  return lines.join('\n') + '\n';
}

function registerUserNixConf(configPath: string): void {
  // Prepending to NIX_USER_CONF_FILES makes our settings win over anything an
  // earlier action wrote. We deliberately don't touch /etc/nix/nix.conf:
  // trusted users (the runner is one) can set post-build-hook / substituters
  // through user-level config and the daemon honors them per-connection. This
  // avoids sudo and a daemon restart for the config side.
  const existing = process.env.NIX_USER_CONF_FILES ?? '';
  const chain = existing ? `${configPath}:${existing}` : configPath;
  core.exportVariable('NIX_USER_CONF_FILES', chain);
}

async function installDaemonEnv(paths: RuntimePaths, inputs: Inputs): Promise<void> {
  // nix-daemon needs AWS creds in its OWN environment to substitute from
  // s3://. Writing them to a systemd EnvironmentFile keeps secrets out
  // of the unit file itself and ties their lifetime to this job.
  const envContent =
    `AWS_ACCESS_KEY_ID=${inputs.r2AccessKeyId}\n` +
    `AWS_SECRET_ACCESS_KEY=${inputs.r2SecretAccessKey}\n`;
  fs.writeFileSync(paths.daemonEnv, envContent, { mode: 0o600 });

  const dropin = `[Service]\nEnvironmentFile=${paths.daemonEnv}\n`;
  await exec('sudo', ['mkdir', '-p', path.dirname(DAEMON_DROPIN_PATH)]);
  await writeSystemFileViaSudo(dropin, DAEMON_DROPIN_PATH, paths.dir);
  await exec('sudo', ['systemctl', 'daemon-reload']);
}

function materializeHook(actionDir: string, paths: RuntimePaths): void {
  const template = fs.readFileSync(path.join(actionDir, 'scripts', 'hook.sh'), 'utf8');
  const rendered = template.replace(/__WISPY_QUEUE_FILE__/g, paths.queue);
  fs.writeFileSync(paths.hook, rendered, { mode: 0o755 });
}

function writeSigningKey(privateKey: string, dest: string): void {
  fs.writeFileSync(dest, privateKey + (privateKey.endsWith('\n') ? '' : '\n'), { mode: 0o600 });
}

function ensureQueueFile(queuePath: string): void {
  fs.writeFileSync(queuePath, '', { mode: 0o666 });
  fs.chmodSync(queuePath, 0o666);
}

async function restartDaemon(): Promise<void> {
  await exec('sudo', ['systemctl', 'restart', 'nix-daemon']);
}

function spawnUploader(paths: RuntimePaths, inputs: Inputs, destUrl: string): number {
  const uploaderJs = path.join(ACTION_ROOT, 'dist', 'uploader', 'index.js');
  const logFd = fs.openSync(paths.log, 'a');
  const child = spawn('node', [uploaderJs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ...serializeUploaderEnv({
        queueFile: paths.queue,
        statusFile: paths.status,
        destUrl,
        concurrency: inputs.uploadConcurrency,
        awsAccessKeyId: inputs.r2AccessKeyId,
        awsSecretAccessKey: inputs.r2SecretAccessKey,
      }),
    },
  });
  child.unref();
  if (!child.pid) throw new Error('Failed to spawn uploader (no PID)');
  fs.writeFileSync(paths.pid, String(child.pid));
  return child.pid;
}

async function run(): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error(`wispy v1 supports Linux runners only (got ${process.platform})`);
  }

  const inputs = parseInputs(readActionInputs());
  const paths = makeRuntimePaths();
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o755 });

  core.setSecret(inputs.r2SecretAccessKey);
  core.setSecret(inputs.signingPrivateKey);

  if (!inputs.skipPush) {
    writeSigningKey(inputs.signingPrivateKey, paths.signingKey);
    materializeHook(ACTION_ROOT, paths);
    ensureQueueFile(paths.queue);
  }

  const destUrl = buildSubstituterUrl(inputs.r2Bucket, inputs.r2AccountId);
  await smokeTestBucket({
    bucket: inputs.r2Bucket,
    accountId: inputs.r2AccountId,
    accessKeyId: inputs.r2AccessKeyId,
    secretAccessKey: inputs.r2SecretAccessKey,
  });

  const userNixConfPath = path.join(paths.dir, 'nix.conf');
  fs.writeFileSync(userNixConfPath, buildUserNixConf(inputs, paths, destUrl), { mode: 0o644 });
  registerUserNixConf(userNixConfPath);

  // The daemon does s3:// fetches itself when substituting, so it needs AWS
  // creds in its own environment. Settings forwarded via NIX_USER_CONF_FILES
  // don't reach the daemon's process env, so this part still requires a
  // systemd drop-in and restart.
  await installDaemonEnv(paths, inputs);
  await restartDaemon();

  if (!inputs.skipPush) {
    const pid = spawnUploader(paths, inputs, destUrl);
    core.info(`wispy uploader started (pid=${pid})`);
  } else {
    core.info('wispy: skip-push=true, push pipeline not started');
  }
}

run().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.setFailed(`wispy setup failed: ${msg}`);
});
