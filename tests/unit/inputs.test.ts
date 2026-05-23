import { describe, it, expect } from 'vitest';
import { parseInputs, type RawInputs } from '../../src/inputs.js';

function raw(o: Partial<RawInputs> = {}): RawInputs {
  return { 'server-url': '', token: '', ...o };
}

describe('parseInputs', () => {
  it('parses a complete set of inputs', () => {
    const r = parseInputs(raw({ 'server-url': 'https://cache.example.com', token: 'eyJ...' }));
    expect(r.serverUrl).toBe('https://cache.example.com');
    expect(r.token).toBe('eyJ...');
  });

  it('rejects empty server-url', () => {
    expect(() => parseInputs(raw({ token: 'x' }))).toThrow(/server-url/);
  });

  it('rejects empty token', () => {
    expect(() => parseInputs(raw({ 'server-url': 'https://x' }))).toThrow(/token/);
  });

  it('rejects non-https server-url', () => {
    expect(() => parseInputs(raw({ 'server-url': 'http://x', token: 'y' }))).toThrow(/https/i);
  });

  it('strips a trailing slash from server-url', () => {
    const r = parseInputs(raw({ 'server-url': 'https://x/', token: 'y' }));
    expect(r.serverUrl).toBe('https://x');
  });
});
