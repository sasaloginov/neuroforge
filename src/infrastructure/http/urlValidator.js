/**
 * Validates that a callback URL does not point to private/internal networks (SSRF protection).
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.',
  '[::1]',
  '[::0]',
  '[0:0:0:0:0:0:0:0]',
  '[0:0:0:0:0:0:0:1]',
]);

/**
 * @param {string} ip — dotted-decimal IPv4 string
 * @returns {boolean}
 */
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  return false;
}

function throwPrivate() {
  throw Object.assign(new Error('callbackUrl must not point to a private/internal address'), {
    statusCode: 400,
  });
}

/**
 * Asserts that callbackUrl is safe (not targeting private networks).
 * Throws an object with statusCode 400 on violation (Fastify convention).
 * @param {string} callbackUrl
 */
export function assertSafeCallbackUrl(callbackUrl) {
  let parsed;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw Object.assign(new Error('Invalid callbackUrl'), { statusCode: 400 });
  }

  const hostname = parsed.hostname;

  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throwPrivate();
  }

  // Strip IPv6 brackets for numeric check
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;

  // IPv6 checks
  if (bare.includes(':')) {
    const lower = bare.toLowerCase();

    // Pure private IPv6 ranges (fc00::/7, fe80::/10, ::1, ::)
    if (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    ) {
      throwPrivate();
    }

    // IPv4-mapped IPv6 — ::ffff:X where X is dotted or hex
    const mapped = lower.match(/^::ffff:(.+)$/);
    if (mapped) {
      const inner = mapped[1];
      // Dotted form: ::ffff:10.0.0.1
      if (inner.includes('.')) {
        if (isPrivateIPv4(inner)) throwPrivate();
      } else {
        // Hex form: ::ffff:a9fe:a9fe → convert two 16-bit groups to IPv4
        const hexParts = inner.split(':');
        if (hexParts.length === 2) {
          const hi = parseInt(hexParts[0], 16);
          const lo = parseInt(hexParts[1], 16);
          if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
            const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
            if (isPrivateIPv4(ipv4)) throwPrivate();
          }
        }
      }
    }
  }

  if (isPrivateIPv4(bare)) {
    throwPrivate();
  }
}
