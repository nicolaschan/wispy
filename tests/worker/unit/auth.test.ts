import { describe, it, expect } from 'vitest';
import { issueToken, verifyToken } from '../../../worker/src/auth.js';

const secret = new TextEncoder().encode('test-secret-do-not-use-in-prod');

describe('verifyToken', () => {
  it('accepts a freshly minted push token', async () => {
    const jwt = await issueToken({ scope: 'push' }, secret);
    const payload = await verifyToken(jwt, secret);
    expect(payload.scope).toBe('push');
  });

  it('rejects a token signed with a different secret', async () => {
    const jwt = await issueToken({ scope: 'push' }, secret);
    const other = new TextEncoder().encode('wrong-secret');
    await expect(verifyToken(jwt, other)).rejects.toThrow(/signature/i);
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const jwt = await issueToken({ scope: 'push', exp: past }, secret);
    await expect(verifyToken(jwt, secret)).rejects.toThrow(/expired/i);
  });

  it('accepts a token without exp claim', async () => {
    const jwt = await issueToken({ scope: 'pull' }, secret);
    const payload = await verifyToken(jwt, secret);
    expect(payload.scope).toBe('pull');
    expect(payload.exp).toBeUndefined();
  });

  it('rejects malformed tokens', async () => {
    await expect(verifyToken('not.a.jwt', secret)).rejects.toThrow();
    await expect(verifyToken('', secret)).rejects.toThrow();
    await expect(verifyToken('only.two', secret)).rejects.toThrow();
  });

  it('rejects a token with scope tampering (constant-time guarantee)', async () => {
    const jwt = await issueToken({ scope: 'pull' }, secret);
    // Re-encode payload claiming push, keeping the original signature.
    const [header, , sig] = jwt.split('.');
    const tampered = JSON.stringify({ scope: 'push', iat: 0 });
    const tamperedB64 = btoa(tampered).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const evil = `${header}.${tamperedB64}.${sig}`;
    await expect(verifyToken(evil, secret)).rejects.toThrow(/signature/i);
  });
});
