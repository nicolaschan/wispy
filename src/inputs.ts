export type RawInputs = Record<string, string>;

export interface Inputs {
  r2Bucket: string;
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  signingPrivateKey: string;
  signingPublicKey: string;
  uploadConcurrency: number;
  extraSubstituters: string[];
  extraTrustedPublicKeys: string[];
  skipPush: boolean;
}

const KEYPAIR_FORMAT = /^[A-Za-z0-9._-]+:[A-Za-z0-9+/=]+$/;

function required(raw: RawInputs, key: string): string {
  const v = (raw[key] ?? '').trim();
  if (!v) throw new Error(`Missing required input: ${key}`);
  return v;
}

function parseInt1(raw: string, key: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Input ${key} must be an integer (got "${raw}")`);
  }
  const n = Number.parseInt(raw, 10);
  if (n < 1) throw new Error(`Input ${key} must be >= 1 (got ${n})`);
  return n;
}

function parseBool(raw: string): boolean {
  return raw.trim().toLowerCase() === 'true';
}

function parseList(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseKey(raw: string, key: string): string {
  if (!KEYPAIR_FORMAT.test(raw)) {
    throw new Error(`Input ${key} must be in name:base64 format`);
  }
  return raw;
}

export function parseInputs(raw: RawInputs): Inputs {
  return {
    r2Bucket: required(raw, 'r2-bucket'),
    r2AccountId: required(raw, 'r2-account-id'),
    r2AccessKeyId: required(raw, 'r2-access-key-id'),
    r2SecretAccessKey: required(raw, 'r2-secret-access-key'),
    signingPrivateKey: parseKey(required(raw, 'signing-private-key'), 'signing-private-key'),
    signingPublicKey: parseKey(required(raw, 'signing-public-key'), 'signing-public-key'),
    uploadConcurrency: parseInt1(raw['upload-concurrency'] ?? '8', 'upload-concurrency'),
    extraSubstituters: parseList(raw['extra-substituters'] ?? ''),
    extraTrustedPublicKeys: parseList(raw['extra-trusted-public-keys'] ?? ''),
    skipPush: parseBool(raw['skip-push'] ?? 'false'),
  };
}
