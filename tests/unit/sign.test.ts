import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { signFingerprint, type SigningKey } from '../../worker/src/sign.js';

const key: SigningKey = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'signing-test-key.json'), 'utf8')
);

function ed25519PubFromRaw(raw: Buffer): ReturnType<typeof createPublicKey> {
  // SPKI prefix for ed25519: 12 bytes, then 32-byte key.
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
}

describe('signFingerprint', () => {
  it('produces a Nix-format Sig line that verifies with the matching public key', async () => {
    const fingerprint = '1;/nix/store/abc-name;sha256:nh;42;';
    const sig = await signFingerprint(fingerprint, key);

    expect(sig).toMatch(/^wispy-test-1:[A-Za-z0-9+/]+=*$/);
    const [, base64] = sig.split(':');
    const sigBytes = Buffer.from(base64!, 'base64');
    expect(sigBytes.length).toBe(64);

    const pubKey = ed25519PubFromRaw(Buffer.from(key.publicKeyBase64, 'base64'));
    const ok = verify(null, Buffer.from(fingerprint, 'utf8'), pubKey, sigBytes);
    expect(ok).toBe(true);
  });

  it('produces deterministic signatures for the same input', async () => {
    const a = await signFingerprint('input', key);
    const b = await signFingerprint('input', key);
    expect(a).toBe(b);
  });
});
