// Web Crypto is what runs on Cloudflare Workers — we deliberately do not
// import from 'node:crypto' here. The same code runs unchanged under both
// the Workers runtime and Node 24 (which exposes the same WebCrypto API).

export interface SigningKey {
  name: string;
  privateKeyBase64: string; // 32-byte seed || 32-byte public key, base64
  publicKeyBase64: string;  // 32-byte public key, base64
}

function base64ToBytes(b64: string): Uint8Array {
  // atob is available in both Workers and Node 24.
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

// PKCS#8 prefix for an ed25519 private key with raw seed appended.
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

async function importPrivateKey(key: SigningKey): Promise<CryptoKey> {
  const combined = base64ToBytes(key.privateKeyBase64);
  if (combined.length !== 64) {
    throw new Error(`expected 64-byte private key, got ${combined.length}`);
  }
  const seed = combined.subarray(0, 32);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

export async function signFingerprint(fingerprint: string, key: SigningKey): Promise<string> {
  const priv = await importPrivateKey(key);
  const data = new TextEncoder().encode(fingerprint);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, priv, data);
  return `${key.name}:${bytesToBase64(new Uint8Array(sig))}`;
}
