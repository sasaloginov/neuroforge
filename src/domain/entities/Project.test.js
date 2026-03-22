import { describe, it, expect } from 'vitest';
import { Project } from './Project.js';
import { ValidationError } from '../errors/ValidationError.js';

describe('Project', () => {
  const defaults = { name: 'my-project', prefix: 'MP', repoUrl: 'https://github.com/org/repo' };

  describe('create', () => {
    it('creates with normalized uppercase prefix', () => {
      const project = Project.create({ ...defaults, prefix: 'mp' });
      expect(project.prefix).toBe('MP');
      expect(project.name).toBe('my-project');
      expect(project.id).toBeDefined();
    });

    it('accepts valid prefixes', () => {
      const cases = ['A', 'NF', 'BOT', 'PROJ123', 'A2B3C4D5E6'];
      for (const prefix of cases) {
        const p = Project.create({ ...defaults, prefix });
        expect(p.prefix).toBe(prefix);
      }
    });

    it('throws ValidationError when prefix is empty', () => {
      expect(() => Project.create({ ...defaults, prefix: '' })).toThrow(ValidationError);
    });

    it('throws ValidationError when prefix is missing', () => {
      expect(() => Project.create({ name: 'x', repoUrl: 'http://x' })).toThrow(ValidationError);
    });

    it('throws ValidationError when prefix starts with digit', () => {
      expect(() => Project.create({ ...defaults, prefix: '1AB' })).toThrow(ValidationError);
    });

    it('throws ValidationError when prefix has special chars', () => {
      expect(() => Project.create({ ...defaults, prefix: 'AB-C' })).toThrow(ValidationError);
    });

    it('throws ValidationError when prefix exceeds 10 chars', () => {
      expect(() => Project.create({ ...defaults, prefix: 'ABCDEFGHIJK' })).toThrow(ValidationError);
    });
  });

  describe('serialization', () => {
    it('roundtrips through toRow/fromRow', () => {
      const project = Project.create(defaults);
      const row = project.toRow();
      expect(row.prefix).toBe('MP');
      const restored = Project.fromRow(row);
      expect(restored.id).toBe(project.id);
      expect(restored.name).toBe(project.name);
      expect(restored.prefix).toBe(project.prefix);
      expect(restored.repoUrl).toBe(project.repoUrl);
    });
  });
});
