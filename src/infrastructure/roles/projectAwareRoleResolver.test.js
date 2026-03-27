import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectAwareRoleResolver } from './projectAwareRoleResolver.js';
import { RoleRegistry } from '../../domain/services/RoleRegistry.js';
import { Role } from '../../domain/valueObjects/Role.js';

const VALID_ROLE_CONTENT = `---
name: developer
model: sonnet
timeout_ms: 60000
allowed_tools:
  - Read
  - Write
---

# PHP Developer

You are a PHP developer.`;

const INVALID_YAML_CONTENT = `---
: broken: yaml: [
---
body`;

describe('ProjectAwareRoleResolver', () => {
  let registry;
  let resolver;
  let logger;
  let tmpDir;

  const globalRole = new Role({
    name: 'developer',
    model: 'opus',
    timeoutMs: 300000,
    allowedTools: ['Read', 'Glob', 'Bash'],
    systemPrompt: 'You are a Node.js developer.',
  });

  beforeEach(async () => {
    registry = new RoleRegistry();
    registry.register(globalRole);
    registry.register(new Role({
      name: 'analyst',
      model: 'opus',
      timeoutMs: 180000,
      allowedTools: [],
      systemPrompt: 'You are an analyst.',
    }));

    logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    resolver = new ProjectAwareRoleResolver({ roleRegistry: registry, logger });

    tmpDir = await mkdtemp(join(tmpdir(), 'nf-role-resolver-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns project-specific role when file exists', async () => {
    const rolesDir = join(tmpDir, '.neuroforge', 'roles');
    await mkdir(rolesDir, { recursive: true });
    await writeFile(join(rolesDir, 'developer.md'), VALID_ROLE_CONTENT);

    const role = await resolver.resolve('developer', tmpDir);

    expect(role.name).toBe('developer');
    expect(role.model).toBe('sonnet');
    expect(role.timeoutMs).toBe(60000);
    expect(role.allowedTools).toEqual(['Read', 'Write']);
    expect(role.systemPrompt).toContain('PHP Developer');
  });

  it('falls back to global role when project file missing', async () => {
    // No .neuroforge/roles/ directory at all
    const role = await resolver.resolve('developer', tmpDir);

    expect(role.name).toBe('developer');
    expect(role.model).toBe('opus');
    expect(role.timeoutMs).toBe(300000);
    expect(role.systemPrompt).toContain('Node.js developer');
  });

  it('falls back to global role when projectWorkDir is null', async () => {
    const role = await resolver.resolve('developer', null);

    expect(role.name).toBe('developer');
    expect(role.model).toBe('opus');
    expect(role.systemPrompt).toContain('Node.js developer');
  });

  it('falls back to global role when roles dir exists but file missing', async () => {
    const rolesDir = join(tmpDir, '.neuroforge', 'roles');
    await mkdir(rolesDir, { recursive: true });
    // No developer.md file

    const role = await resolver.resolve('developer', tmpDir);

    expect(role.model).toBe('opus');
    expect(role.systemPrompt).toContain('Node.js developer');
  });

  it('throws on invalid YAML in project role file (fail fast)', async () => {
    const rolesDir = join(tmpDir, '.neuroforge', 'roles');
    await mkdir(rolesDir, { recursive: true });
    await writeFile(join(rolesDir, 'developer.md'), INVALID_YAML_CONTENT);

    await expect(resolver.resolve('developer', tmpDir)).rejects.toThrow('Invalid YAML');
  });

  it('falls back to global when projectWorkDir does not exist', async () => {
    const role = await resolver.resolve('developer', '/tmp/no-such-dir-999');

    expect(role.name).toBe('developer');
    expect(role.model).toBe('opus');
  });

  it('throws RoleNotFoundError when role missing globally and no project override', async () => {
    await expect(resolver.resolve('nonexistent', tmpDir)).rejects.toThrow('Role not found: nonexistent');
  });

  it('resolves different roles independently', async () => {
    const rolesDir = join(tmpDir, '.neuroforge', 'roles');
    await mkdir(rolesDir, { recursive: true });
    await writeFile(join(rolesDir, 'developer.md'), VALID_ROLE_CONTENT);
    // No analyst.md in project

    const developer = await resolver.resolve('developer', tmpDir);
    const analyst = await resolver.resolve('analyst', tmpDir);

    expect(developer.model).toBe('sonnet'); // project override
    expect(analyst.model).toBe('opus'); // global fallback
  });
});
