import { RoleNotFoundError } from '../errors/RoleNotFoundError.js';

export class RoleRegistry {
  #roles = new Map();

  register(role) {
    this.#roles.set(role.name, role);
  }

  get(name) {
    const role = this.#roles.get(name);
    if (!role) throw new RoleNotFoundError(name);
    return role;
  }

  has(name) {
    return this.#roles.has(name);
  }

  getAll() {
    return [...this.#roles.values()];
  }
}
