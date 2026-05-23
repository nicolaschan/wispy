import { describe, it, expect } from 'vitest';
import { buildSubstituterUrl, r2EndpointUrl } from '../../src/r2.js';

describe('r2EndpointUrl', () => {
  it('builds the per-account endpoint URL', () => {
    expect(r2EndpointUrl('abc123')).toBe('https://abc123.r2.cloudflarestorage.com');
  });
});

describe('buildSubstituterUrl', () => {
  it('builds an s3:// URL with endpoint and region=auto', () => {
    const url = buildSubstituterUrl('my-bucket', 'abc123');
    expect(url).toBe(
      's3://my-bucket?endpoint=https://abc123.r2.cloudflarestorage.com&region=auto',
    );
  });

  it('throws on empty bucket or account id', () => {
    expect(() => buildSubstituterUrl('', 'abc')).toThrowError(/bucket/);
    expect(() => buildSubstituterUrl('b', '')).toThrowError(/account/);
  });
});
