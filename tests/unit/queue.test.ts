import { describe, it, expect } from 'vitest';
import { QueueParser, SENTINEL } from '../../src/queue.js';

describe('QueueParser', () => {
  it('emits paths from a single complete line', () => {
    const p = new QueueParser();
    const result = p.feed('/nix/store/abc-foo\n');
    expect(result.paths).toEqual(['/nix/store/abc-foo']);
    expect(result.sentinelSeen).toBe(false);
  });

  it('splits multi-path lines on whitespace', () => {
    const p = new QueueParser();
    expect(p.feed('/nix/store/a /nix/store/b\n').paths).toEqual([
      '/nix/store/a',
      '/nix/store/b',
    ]);
  });

  it('buffers partial trailing lines across feeds', () => {
    const p = new QueueParser();
    expect(p.feed('/nix/store/a').paths).toEqual([]);
    expect(p.feed('bc\n').paths).toEqual(['/nix/store/abc']);
  });

  it('deduplicates paths across all feeds (idempotent submission)', () => {
    const p = new QueueParser();
    expect(p.feed('/nix/store/a\n').paths).toEqual(['/nix/store/a']);
    expect(p.feed('/nix/store/a\n/nix/store/b\n').paths).toEqual(['/nix/store/b']);
  });

  it('reports sentinel and emits any paths before it', () => {
    const p = new QueueParser();
    const r = p.feed(`/nix/store/last\n${SENTINEL}\n/nix/store/ignored\n`);
    expect(r.paths).toEqual(['/nix/store/last']);
    expect(r.sentinelSeen).toBe(true);
  });

  it('ignores empty lines and pure-whitespace lines', () => {
    const p = new QueueParser();
    expect(p.feed('\n   \n\t\n').paths).toEqual([]);
    expect(p.feed('\n').sentinelSeen).toBe(false);
  });
});
