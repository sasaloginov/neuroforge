import { describe, it, expect } from 'vitest';
import { assertProjectScope, assertAdmin } from './scopeHelpers.js';

describe('scopeHelpers', () => {
  describe('assertProjectScope', () => {
    it('passes when apiKey has no projectId scope', () => {
      const apiKey = { projectId: null };
      expect(() => assertProjectScope(apiKey, 'any-project-id')).not.toThrow();
    });

    it('passes when apiKey projectId matches requested projectId', () => {
      const apiKey = { projectId: 'proj-1' };
      expect(() => assertProjectScope(apiKey, 'proj-1')).not.toThrow();
    });

    it('throws 403 when apiKey projectId differs from requested', () => {
      const apiKey = { projectId: 'proj-1' };
      try {
        assertProjectScope(apiKey, 'proj-2');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.message).toMatch(/restricted/);
      }
    });
  });

  describe('assertAdmin', () => {
    it('passes for admin role', () => {
      expect(() => assertAdmin({ role: 'admin' })).not.toThrow();
    });

    it('throws 403 for member role', () => {
      try {
        assertAdmin({ role: 'member' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.message).toMatch(/Admin/);
      }
    });
  });
});
