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

  describe('blocks IPv4-mapped IPv6', () => {
    it('blocks ::ffff:127.0.0.1 (dotted form)', () => {
      expect(() => assertSafeCallbackUrl('https://[::ffff:127.0.0.1]/callback')).toThrow();
    });

    it('blocks ::ffff:10.0.0.1 (dotted form)', () => {
      expect(() => assertSafeCallbackUrl('https://[::ffff:10.0.0.1]/callback')).toThrow();
    });

    it('blocks ::ffff:169.254.169.254 (dotted form)', () => {
      expect(() => assertSafeCallbackUrl('https://[::ffff:169.254.169.254]/callback')).toThrow();
    });

    it('blocks ::ffff:a9fe:a9fe (hex form — 169.254.169.254)', () => {
      expect(() => assertSafeCallbackUrl('https://[::ffff:a9fe:a9fe]/callback')).toThrow();
    });

    it('blocks ::ffff:0a00:0001 (hex form — 10.0.0.1)', () => {
      expect(() => assertSafeCallbackUrl('https://[::ffff:0a00:0001]/callback')).toThrow();
    });

    it('blocks ::ffff:c0a8:0101 (hex form — 192.168.1.1)', () => {
      expect(() => assertSafeCallbackUrl('https://[::ffff:c0a8:0101]/callback')).toThrow();
    });

    it('allows ::ffff: with public IP (hex form)', () => {
      expect(() => assertSafeCallbackUrl('https://[::ffff:0808:0808]/callback')).not.toThrow();
    });

    it('allows ::ffff: with public IP (dotted form)', () => {
      expect(() => assertSafeCallbackUrl('https://[::ffff:8.8.8.8]/callback')).not.toThrow();
    });
  });

  it('rejects non-parseable URLs', () => {
    expect(() => assertSafeCallbackUrl('not-a-url')).toThrow();
  });

  describe('ALLOW_PRIVATE_CALLBACKS', () => {
    it('allows localhost when ALLOW_PRIVATE_CALLBACKS=true', () => {
      process.env.ALLOW_PRIVATE_CALLBACKS = 'true';
      try {
        expect(() => assertSafeCallbackUrl('http://localhost:3001/callback')).not.toThrow();
        expect(() => assertSafeCallbackUrl('http://127.0.0.1:3001/callback')).not.toThrow();
      } finally {
        delete process.env.ALLOW_PRIVATE_CALLBACKS;
      }
    });

    it('still blocks private IPs when flag is not set', () => {
      delete process.env.ALLOW_PRIVATE_CALLBACKS;
      expect(() => assertSafeCallbackUrl('http://localhost:3001/callback')).toThrow();
    });
  });
});
