import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNarinfo, serializeNarinfo, fingerprint, type Narinfo } from '../../worker/src/narinfo.js';

const fixturePath = (name: string) =>
  join(import.meta.dirname, '..', 'fixtures', name);

describe('parseNarinfo', () => {
  it('extracts every required field from the fixture', () => {
    const text = readFileSync(fixturePath('sample.narinfo'), 'utf8');
    const n = parseNarinfo(text);
    expect(n.storePath).toBe('/nix/store/abc123-hello-2.12.1');
    expect(n.url).toBe('nar/0xyz.nar.zst');
    expect(n.compression).toBe('zstd');
    expect(n.fileHash).toBe('sha256:1abcdefghijklmnopqrstuvwxyz23456789abcdefghijklmnop');
    expect(n.fileSize).toBe(12345);
    expect(n.narHash).toBe('sha256:1zyxwvutsrqponmlkjihgfedcba98765432123456789abcdefg');
    expect(n.narSize).toBe(67890);
    expect(n.references).toEqual(['def456-glibc-2.40', 'ghi789-libc++-19']);
    expect(n.deriver).toBe('jkl012-hello-2.12.1.drv');
    expect(n.sig).toBeUndefined();
  });

  it('handles an empty References field as an empty array', () => {
    const text = 'StorePath: /nix/store/abc-name\nURL: nar/x.nar.zst\nCompression: zstd\nFileHash: sha256:a\nFileSize: 1\nNarHash: sha256:b\nNarSize: 2\nReferences: \n';
    const n = parseNarinfo(text);
    expect(n.references).toEqual([]);
  });

  it('throws on missing required fields', () => {
    expect(() => parseNarinfo('StorePath: /nix/store/x\n')).toThrow(/missing required/i);
  });

  it('throws on non-numeric size fields', () => {
    const text = 'StorePath: /nix/store/abc-name\nURL: nar/x\nCompression: zstd\nFileHash: sha256:a\nFileSize: not-a-number\nNarHash: sha256:b\nNarSize: 2\nReferences: \n';
    expect(() => parseNarinfo(text)).toThrow(/FileSize must be a non-negative integer/);
  });
});

describe('serializeNarinfo', () => {
  it('emits Nix-canonical key order with a trailing newline', () => {
    const n: Narinfo = {
      storePath: '/nix/store/abc-name',
      url: 'nar/x.nar.zst',
      compression: 'zstd',
      fileHash: 'sha256:a',
      fileSize: 1,
      narHash: 'sha256:b',
      narSize: 2,
      references: ['ref1-name'],
      deriver: 'd.drv',
      sig: 'cache-1:abc==',
    };
    expect(serializeNarinfo(n)).toBe(
      'StorePath: /nix/store/abc-name\n' +
      'URL: nar/x.nar.zst\n' +
      'Compression: zstd\n' +
      'FileHash: sha256:a\n' +
      'FileSize: 1\n' +
      'NarHash: sha256:b\n' +
      'NarSize: 2\n' +
      'References: ref1-name\n' +
      'Deriver: d.drv\n' +
      'Sig: cache-1:abc==\n'
    );
  });

  it('omits Deriver and Sig when absent', () => {
    const n: Narinfo = {
      storePath: '/nix/store/abc-name',
      url: 'nar/x.nar.zst',
      compression: 'zstd',
      fileHash: 'sha256:a',
      fileSize: 1,
      narHash: 'sha256:b',
      narSize: 2,
      references: [],
    };
    const s = serializeNarinfo(n);
    expect(s).not.toContain('Deriver');
    expect(s).not.toContain('Sig');
  });
});

describe('fingerprint', () => {
  it('matches the Nix C++ format: 1;<storePath>;<narHash>;<narSize>;<refs joined by comma>', () => {
    const n: Narinfo = {
      storePath: '/nix/store/abc-name',
      url: 'nar/x',
      compression: 'zstd',
      fileHash: 'sha256:a',
      fileSize: 1,
      narHash: 'sha256:nh',
      narSize: 42,
      references: ['def-r1', 'ghi-r2'],
    };
    expect(fingerprint(n, '/nix/store')).toBe(
      '1;/nix/store/abc-name;sha256:nh;42;/nix/store/def-r1,/nix/store/ghi-r2'
    );
  });

  it('emits an empty refs section when references is empty', () => {
    const n: Narinfo = {
      storePath: '/nix/store/abc-name',
      url: 'nar/x',
      compression: 'zstd',
      fileHash: 'sha256:a',
      fileSize: 1,
      narHash: 'sha256:nh',
      narSize: 42,
      references: [],
    };
    expect(fingerprint(n, '/nix/store')).toBe('1;/nix/store/abc-name;sha256:nh;42;');
  });
});
