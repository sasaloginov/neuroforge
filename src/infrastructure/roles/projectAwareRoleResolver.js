import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { IRoleResolver } from '../../domain/ports/IRoleResolver.js';
import { parseRoleFile } from './fileRoleLoader.js';

/**
 * Resolves roles with per-project override support.
 *
 * Resolution order:
 * 1. If projectWorkDir provided — check <workDir>/.neuroforge/roles/<roleName>.md
 * 2. If found and valid — return project-specific Role
 * 3. Otherwise — fallback to global RoleRegistry
 */
export class ProjectAwareRoleResolver extends IRoleResolver {
  #roleRegistry;
  #logger;

  /**
   * @param {object} deps
   * @param {import('../../domain/services/RoleRegistry.js').RoleRegistry} deps.roleRegistry
   * @param {object} [deps.logger]
   */
  constructor({ roleRegistry, logger }) {
    super();
    this.#roleRegistry = roleRegistry;
    this.#logger = logger || console;
  }

  /**
   * @param {string} roleName
   * @param {string|null} [projectWorkDir]
   * @returns {Promise<import('../../domain/valueObjects/Role.js').Role>}
   */
  async resolve(roleName, projectWorkDir = null) {
    if (projectWorkDir) {
      const projectRolePath = join(projectWorkDir, '.neuroforge', 'roles', `${roleName}.md`);
      try {
        await access(projectRolePath);
      } catch {
        // File not accessible — fallback to global
        return this.#roleRegistry.get(roleName);
      }
      // File exists — parse it; let parse errors propagate (fail fast)
      const content = await readFile(projectRolePath, 'utf-8');
      const role = parseRoleFile(content, `${roleName}.md`);
      this.#logger.info('[RoleResolver] Using project role: %s from %s', roleName, projectRolePath);
      return role;
    }
    return this.#roleRegistry.get(roleName);
  }
}
