import { describe, it, expect } from 'vitest';
import { applyWispyBlock, removeWispyBlock } from '../../src/nixconf.js';

const block = `extra-substituters = s3://bucket?endpoint=https://x.r2.cloudflarestorage.com&region=auto
extra-trusted-public-keys = wispy-1:abc=
secret-key-files = /tmp/wispy/key
post-build-hook = /tmp/wispy/hook.sh`;

describe('applyWispyBlock', () => {
  it('appends a wrapped block to an empty config', () => {
    const result = applyWispyBlock('', block);
    expect(result).toContain('# >>> wispy >>>');
    expect(result).toContain('# <<< wispy <<<');
    expect(result).toContain('extra-substituters = s3://bucket');
  });

  it('appends to an existing config without overwriting', () => {
    const existing = 'experimental-features = nix-command flakes\n';
    const result = applyWispyBlock(existing, block);
    expect(result.startsWith(existing)).toBe(true);
    expect(result).toContain('# >>> wispy >>>');
  });

  it('replaces an existing wispy block (idempotent re-apply)', () => {
    const first = applyWispyBlock('existing line\n', 'old block content');
    const second = applyWispyBlock(first, block);
    expect(second).toContain('existing line');
    expect(second).not.toContain('old block content');
    expect(second).toContain('extra-substituters = s3://bucket');
    expect(second.match(/# >>> wispy >>>/g)?.length).toBe(1);
  });

  it('ensures the existing content ends with a newline before appending', () => {
    const result = applyWispyBlock('no-trailing-newline', block);
    expect(result).toContain('no-trailing-newline\n# >>> wispy >>>');
  });
});

describe('removeWispyBlock', () => {
  it('removes a wispy block exactly', () => {
    const conf = applyWispyBlock('preserved line\n', block);
    const result = removeWispyBlock(conf);
    expect(result).toBe('preserved line\n');
  });

  it('is a no-op when no block is present', () => {
    const conf = 'just some lines\nno block here\n';
    expect(removeWispyBlock(conf)).toBe(conf);
  });

  it('only removes content between markers, never outside them', () => {
    const conf = 'before\n# >>> wispy >>>\nmiddle\n# <<< wispy <<<\nafter\n';
    expect(removeWispyBlock(conf)).toBe('before\nafter\n');
  });

  it('round-trip apply then remove returns original (with normalized trailing newline)', () => {
    const original = 'line1\nline2\n';
    const applied = applyWispyBlock(original, block);
    const removed = removeWispyBlock(applied);
    expect(removed).toBe(original);
  });
});
