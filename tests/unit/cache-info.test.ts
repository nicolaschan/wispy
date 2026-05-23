import { describe, it, expect } from 'vitest';
import { parseCacheInfo } from '../../src/cache-info.js';

const FULL = 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\nWispy-PublicKey: cache-1:AAAA==\n';

describe('parseCacheInfo', () => {
  it('extracts StoreDir, Priority, WantMassQuery, and Wispy-PublicKey', () => {
    const info = parseCacheInfo(FULL);
    expect(info.storeDir).toBe('/nix/store');
    expect(info.priority).toBe(30);
    expect(info.wantMassQuery).toBe(true);
    expect(info.publicKey).toBe('cache-1:AAAA==');
  });

  it('defaults WantMassQuery to false when absent', () => {
    const info = parseCacheInfo('StoreDir: /nix/store\nPriority: 50\nWispy-PublicKey: cache-1:AAAA==\n');
    expect(info.wantMassQuery).toBe(false);
  });

  it('throws if StoreDir is missing', () => {
    expect(() => parseCacheInfo('Priority: 30\nWispy-PublicKey: cache-1:AAAA==\n')).toThrow(/StoreDir/);
  });

  it('throws if Wispy-PublicKey is missing', () => {
    expect(() => parseCacheInfo('StoreDir: /nix/store\n')).toThrow(/Wispy-PublicKey/);
  });
});
