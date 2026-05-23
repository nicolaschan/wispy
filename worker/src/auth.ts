export interface TokenPayload {
  scope: 'push' | 'pull';
  iat?: number;
  exp?: number;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function issueToken(payload: TokenPayload, secret: Uint8Array): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = new TextEncoder();
  const iat = payload.iat ?? Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat };
  const headerB64 = b64urlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  const sigB64 = b64urlEncode(new Uint8Array(sig));
  return `${signingInput}.${sigB64}`;
}

export async function verifyToken(jwt: string, secret: Uint8Array): Promise<TokenPayload> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('jwt: expected 3 segments');
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const enc = new TextEncoder();
  const key = await hmacKey(secret);
  const sigBytes = b64urlDecode(sigB64);
  const signingInput = enc.encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, signingInput);
  if (!ok) throw new Error('jwt: bad signature');

  const payloadJson = new TextDecoder().decode(b64urlDecode(payloadB64));
  const payload = JSON.parse(payloadJson) as TokenPayload;

  if (payload.exp !== undefined) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= payload.exp) throw new Error('jwt: expired');
  }
  if (payload.scope !== 'push' && payload.scope !== 'pull') {
    throw new Error(`jwt: invalid scope "${payload.scope}"`);
  }
  return payload;
}
