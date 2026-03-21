import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoles, parseRoleFile } from './fileRoleLoader.js';
import { Role } from '../../domain/valueObjects/Role.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROLES_DIR = resolve(__dirname, '../../../roles');

describe('FileRoleLoader', () => {
  describe('loadRoles()', () => {
    it('should load all 8 role files from roles/', async () => {
      const roles = await loadRoles(ROLES_DIR);
      expect(roles).toHaveLength(8);
      roles.forEach((r) => expect(r).toBeInstanceOf(Role));
    });

    it('should load roles with correct names', async () => {
      const roles = await loadRoles(ROLES_DIR);
      const names = roles.map((r) => r.name).sort();
      expect(names).toEqual([
        'analyst',
        'default',
        'developer',
        'manager',
        'reviewer-architecture',
        'reviewer-business',
        'reviewer-security',
        'tester',
      ]);
    });

    it('should parse analyst role correctly', async () => {
      const roles = await loadRoles(ROLES_DIR);
      const analyst = roles.find((r) => r.name === 'analyst');
      expect(analyst.model).toBe('opus');
      expect(analyst.timeoutMs).toBe(300000);
      expect(analyst.allowedTools).toContain('Read');
      expect(analyst.allowedTools).toContain('WebSearch');
      expect(analyst.systemPrompt).toContain('аналитик');
    });

    it('should parse manager role with correct tools', async () => {
      const roles = await loadRoles(ROLES_DIR);
      const manager = roles.find((r) => r.name === 'manager');
      expect(manager.model).toBe('opus');
      expect(manager.allowedTools).toContain('Read');
      expect(manager.allowedTools).toContain('Glob');
    });
  });

  describe('parseRoleFile()', () => {
    it('should parse valid frontmatter + body', () => {
      const content = `---
name: test-role
model: sonnet
timeout_ms: 60000
allowed_tools:
  - Read
  - Bash
---

# Test Role

You are a test role.`;

      const role = parseRoleFile(content, 'test.md');
      expect(role.name).toBe('test-role');
      expect(role.model).toBe('sonnet');
      expect(role.timeoutMs).toBe(60000);
      expect(role.allowedTools).toEqual(['Read', 'Bash']);
      expect(role.systemPrompt).toBe('# Test Role\n\nYou are a test role.');
    });

    it('should throw on missing frontmatter delimiters', () => {
      expect(() => parseRoleFile('no frontmatter', 'bad.md')).toThrow('missing --- delimiters');
    });

    it('should throw on missing name', () => {
      const content = `---
model: opus
timeout_ms: 60000
---
body`;
      expect(() => parseRoleFile(content, 'bad.md')).toThrow("Missing 'name'");
    });

    it('should throw on invalid YAML', () => {
      const content = `---
: invalid: yaml: [
---
body`;
      expect(() => parseRoleFile(content, 'bad.md')).toThrow('Invalid YAML');
    });

    it('should default allowed_tools to empty array', () => {
      const content = `---
name: minimal
model: haiku
timeout_ms: 30000
---
body`;
      const role = parseRoleFile(content, 'minimal.md');
      expect(role.allowedTools).toEqual([]);
    });
  });
});
