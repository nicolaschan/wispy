import { readFileSync, writeFileSync } from 'node:fs';

// Status is written by uploader.ts on exit and read by post.ts.
// This is the single source of truth for its shape.
export interface Status {
  pathsPushed: number;
  bytesPushed: number;
  pathsFailed: number;
  wallTimeMs: number;
}

export function writeStatus(path: string, s: Status): void {
  writeFileSync(path, JSON.stringify(s, null, 2));
}

export function readStatus(path: string): Status {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`status.json malformed: not an object`);
  }
  const o = raw as Record<string, unknown>;
  if (
    typeof o.pathsPushed !== 'number' ||
    typeof o.bytesPushed !== 'number' ||
    typeof o.pathsFailed !== 'number' ||
    typeof o.wallTimeMs !== 'number'
  ) {
    throw new Error(`status.json malformed: missing required numeric fields`);
  }
  return {
    pathsPushed: o.pathsPushed,
    bytesPushed: o.bytesPushed,
    pathsFailed: o.pathsFailed,
    wallTimeMs: o.wallTimeMs,
  };
}

// UploaderEnv is what main.ts hands to the spawned uploader child via env vars.
// Both the writer (main) and the reader (uploader) use this type.
export interface UploaderEnv {
  queueFile: string;
  statusFile: string;
  destUrl: string;
  concurrency: number;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
}

const ENV_KEYS = {
  queueFile: 'WISPY_QUEUE_FILE',
  statusFile: 'WISPY_STATUS_FILE',
  destUrl: 'WISPY_DEST_URL',
  concurrency: 'WISPY_UPLOAD_CONCURRENCY',
  awsAccessKeyId: 'AWS_ACCESS_KEY_ID',
  awsSecretAccessKey: 'AWS_SECRET_ACCESS_KEY',
} as const;

export function serializeUploaderEnv(env: UploaderEnv): Record<string, string> {
  return {
    [ENV_KEYS.queueFile]: env.queueFile,
    [ENV_KEYS.statusFile]: env.statusFile,
    [ENV_KEYS.destUrl]: env.destUrl,
    [ENV_KEYS.concurrency]: String(env.concurrency),
    [ENV_KEYS.awsAccessKeyId]: env.awsAccessKeyId,
    [ENV_KEYS.awsSecretAccessKey]: env.awsSecretAccessKey,
  };
}

export function parseUploaderEnv(source: NodeJS.ProcessEnv): UploaderEnv {
  function need(key: string): string {
    const v = source[key];
    if (!v) throw new Error(`Uploader missing env var: ${key}`);
    return v;
  }
  const concurrencyRaw = need(ENV_KEYS.concurrency);
  const concurrency = Number.parseInt(concurrencyRaw, 10);
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(
      `Uploader ${ENV_KEYS.concurrency} must be a positive integer (got "${concurrencyRaw}")`,
    );
  }
  return {
    queueFile: need(ENV_KEYS.queueFile),
    statusFile: need(ENV_KEYS.statusFile),
    destUrl: need(ENV_KEYS.destUrl),
    concurrency,
    awsAccessKeyId: need(ENV_KEYS.awsAccessKeyId),
    awsSecretAccessKey: need(ENV_KEYS.awsSecretAccessKey),
  };
}
