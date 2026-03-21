import { RoleRegistry } from './RoleRegistry.js';
import { Role } from '../valueObjects/Role.js';
import { RoleNotFoundError } from '../errors/RoleNotFoundError.js';

describe('RoleRegistry', () => {
  const makeRole = (name) => new Role({ name, model: 'opus', timeoutMs: 120000, allowedTools: ['Read'], systemPrompt: 'test' });

  it('registers and retrieves a role', () => {
    const registry = new RoleRegistry();
    const role = makeRole('developer');
    registry.register(role);
    expect(registry.get('developer')).toBe(role);
  });

  it('has() returns true/false', () => {
    const registry = new RoleRegistry();
    registry.register(makeRole('analyst'));
    expect(registry.has('analyst')).toBe(true);
    expect(registry.has('wizard')).toBe(false);
  });

  it('getAll() returns all registered roles', () => {
    const registry = new RoleRegistry();
    registry.register(makeRole('a'));
    registry.register(makeRole('b'));
    expect(registry.getAll()).toHaveLength(2);
  });

  it('throws RoleNotFoundError for unknown role', () => {
    const registry = new RoleRegistry();
    expect(() => registry.get('nope')).toThrow(RoleNotFoundError);
  });
});
