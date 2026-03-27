/**
 * Port for resolving roles with optional project-level overrides.
 *
 * @interface IRoleResolver
 */
export class IRoleResolver {
  /**
   * Resolve a role by name, optionally checking project-specific overrides first.
   *
   * @param {string} roleName
   * @param {string|null} [projectWorkDir] — if provided, check project-specific role first
   * @returns {Promise<import('../valueObjects/Role.js').Role>}
   */
  async resolve(roleName, projectWorkDir = null) {
    throw new Error('Not implemented');
  }
}
