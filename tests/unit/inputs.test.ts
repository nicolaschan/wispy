import { describe, it, expect } from 'vitest';
import { parseInputs, type RawInputs } from '../../src/inputs.js';

const valid: RawInputs = {
  'r2-bucket': 'my-cache',
  'r2-account-id': 'abc123',
  'r2-access-key-id': 'AK',
  'r2-secret-access-key': 'SK',
  'signing-private-key': 'wispy-1:secret==',
  'signing-public-key': 'wispy-1:public==',
  'upload-concurrency': '8',
  'extra-substituters': 'https://cache.nixos.org/',
  'extra-trusted-public-keys': 'cache.nixos.org-1:abc=',
  'skip-push': 'false',
};

describe('parseInputs', () => {
  it('parses a valid input set', () => {
    const result = parseInputs(valid);
    expect(result.r2Bucket).toBe('my-cache');
    expect(result.r2AccountId).toBe('abc123');
    expect(result.uploadConcurrency).toBe(8);
    expect(result.skipPush).toBe(false);
    expect(result.extraSubstituters).toEqual(['https://cache.nixos.org/']);
  });

  it('throws on missing required input with a clear message', () => {
    const broken = { ...valid, 'r2-bucket': '' };
    expect(() => parseInputs(broken)).toThrowError(/r2-bucket/);
  });

  it('parses skip-push as boolean (true/false case-insensitive)', () => {
    expect(parseInputs({ ...valid, 'skip-push': 'true' }).skipPush).toBe(true);
    expect(parseInputs({ ...valid, 'skip-push': 'TRUE' }).skipPush).toBe(true);
    expect(parseInputs({ ...valid, 'skip-push': 'false' }).skipPush).toBe(false);
    expect(parseInputs({ ...valid, 'skip-push': '' }).skipPush).toBe(false);
  });

  it('rejects non-integer upload-concurrency', () => {
    expect(() => parseInputs({ ...valid, 'upload-concurrency': 'eight' })).toThrowError(
      /upload-concurrency.*integer/,
    );
  });

  it('rejects upload-concurrency < 1', () => {
    expect(() => parseInputs({ ...valid, 'upload-concurrency': '0' })).toThrowError(
      /upload-concurrency.*>= 1/,
    );
  });

  it('splits space-separated list inputs and trims', () => {
    const result = parseInputs({
      ...valid,
      'extra-substituters': '  https://a.example/   https://b.example/  ',
    });
    expect(result.extraSubstituters).toEqual(['https://a.example/', 'https://b.example/']);
  });

  it('rejects signing-private-key without the expected name:key form', () => {
    expect(() => parseInputs({ ...valid, 'signing-private-key': 'notvalid' })).toThrowError(
      /signing-private-key.*name:base64/,
    );
  });
});
