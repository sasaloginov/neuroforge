import { Role } from './Role.js';

describe('Role', () => {
  const defaults = { name: 'developer', model: 'opus', timeoutMs: 600000, allowedTools: ['Read', 'Write'], systemPrompt: 'You are a dev' };

  describe('create', () => {
    it('creates with valid params', () => {
      const role = new Role(defaults);
      expect(role.name).toBe('developer');
      expect(role.model).toBe('opus');
      expect(role.timeoutMs).toBe(600000);
      expect(role.allowedTools).toEqual(['Read', 'Write']);
      expect(role.systemPrompt).toBe('You are a dev');
    });
  });

  describe('validation', () => {
    it('rejects missing name', () => {
      expect(() => new Role({ ...defaults, name: '' })).toThrow('name is required');
    });

    it('rejects invalid model', () => {
      expect(() => new Role({ ...defaults, model: 'gpt-4' })).toThrow('Invalid model');
    });

    it('rejects non-positive timeout', () => {
      expect(() => new Role({ ...defaults, timeoutMs: 0 })).toThrow('timeoutMs must be positive');
    });
  });

  describe('immutability', () => {
    it('allowedTools is frozen', () => {
      const role = new Role(defaults);
      expect(() => { role.allowedTools.push('Bash'); }).toThrow();
    });
  });

  describe('equals', () => {
    it('equals by name', () => {
      const a = new Role(defaults);
      const b = new Role({ ...defaults, timeoutMs: 100000 });
      expect(a.equals(b)).toBe(true);
    });

    it('not equals with different name', () => {
      const a = new Role(defaults);
      const b = new Role({ ...defaults, name: 'analyst' });
      expect(a.equals(b)).toBe(false);
    });
  });
});
