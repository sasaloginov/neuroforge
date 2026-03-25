import { describe, it, expect } from 'vitest';
import { assertSafeCallbackUrl } from './urlValidator.js';

describe('assertSafeCallbackUrl', () => {
  it('allows public https URLs', () => {
    expect(() => assertSafeCallbackUrl('https://example.com/webhook')).not.toThrow();
    expect(() => assertSafeCallbackUrl('https://api.myapp.io/callback')).not.toThrow();
    expect(() => assertSafeCallbackUrl('http://hooks.external.com/notify')).not.toThrow();
  });

  describe('blocks private IPv4 ranges', () => {
    const blocked = [
      '127.0.0.1',
      '127.0.0.2',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.255.255',
      '169.254.169.254',
      '0.0.0.0',
    ];

    for (const ip of blocked) {
      it(`blocks ${ip}`, () => {
        expect(() => assertSafeCallbackUrl(`https://${ip}/callback`)).toThrow();
      });
    }
  });

  it('allows public IPv4', () => {
    expect(() => assertSafeCallbackUrl('https://8.8.8.8/callback')).not.toThrow();
    expect(() => assertSafeCallbackUrl('https://203.0.113.1/callback')).not.toThrow();
  });

  describe('blocks localhost variants', () => {
    it('blocks localhost', () => {
      expect(() => assertSafeCallbackUrl('https://localhost/callback')).toThrow();
    });

    it('blocks localhost.', () => {
      expect(() => assertSafeCallbackUrl('https://localhost./callback')).toThrow();
    });
  });

  describe('blocks private IPv6', () => {
    it('blocks [::1]', () => {
      expect(() => assertSafeCallbackUrl('https://[::1]/callback')).toThrow();
    });

    it('blocks fc00:: (unique local)', () => {
      expect(() => assertSafeCallbackUrl('https://[fc00::1]/callback')).toThrow();
    });

    it('blocks fd00:: (unique local)', () => {
      expect(() => assertSafeCallbackUrl('https://[fd12::1]/callback')).toThrow();
    });

    it('blocks fe80:: (link-local)', () => {
      expect(() => assertSafeCallbackUrl('https://[fe80::1]/callback')).toThrow();
    });
  });

  it('rejects non-parseable URLs', () => {
    expect(() => assertSafeCallbackUrl('not-a-url')).toThrow();
  });
});
