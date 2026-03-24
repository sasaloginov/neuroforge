import { createHash, randomBytes } from 'node:crypto';
import { Project } from '../../src/domain/entities/Project.js';
import { User } from '../../src/domain/entities/User.js';
import { ApiKey } from '../../src/domain/entities/ApiKey.js';
import { PgProjectRepo } from '../../src/infrastructure/persistence/PgProjectRepo.js';
import { PgUserRepo } from '../../src/infrastructure/persistence/PgUserRepo.js';
import { PgApiKeyRepo } from '../../src/infrastructure/persistence/PgApiKeyRepo.js';

/**
 * Registers a new project in the database: creates project, user, and API key.
 * Reuses existing domain entities and infrastructure repos.
 */
export class ProjectRegistrar {
  #projectRepo;
  #userRepo;
  #apiKeyRepo;

  constructor({ pool }) {
    this.#projectRepo = new PgProjectRepo(pool);
    this.#userRepo = new PgUserRepo(pool);
    this.#apiKeyRepo = new PgApiKeyRepo(pool);
  }

  /**
   * Register a project with all related entities.
   * @param {{ name: string, prefix: string, repoUrl: string, workDir: string }} params
   * @returns {Promise<{ project: Project, user: User, apiKey: { id: string, name: string, token: string } }>}
   */
  async register({ name, prefix, repoUrl, workDir }) {
    // Check for duplicate name
    const existingByName = await this.#projectRepo.findByName(name);
    if (existingByName) {
      throw new Error(`Project with name "${name}" already exists`);
    }

    // Check for duplicate prefix
    const existingByPrefix = await this.#projectRepo.findByPrefix(prefix.toUpperCase());
    if (existingByPrefix) {
      throw new Error(`Project with prefix "${prefix.toUpperCase()}" already exists`);
    }

    // 1. Create project
    const project = Project.create({ name, prefix, repoUrl, workDir });
    await this.#projectRepo.save(project);

    // 2. Create user for the project
    const user = User.create({ name: `${name}-agent`, role: 'member' });
    await this.#userRepo.save(user);

    // 3. Create API key bound to user + project
    const rawToken = 'nf_' + randomBytes(32).toString('hex');
    const keyHash = createHash('sha256').update(rawToken).digest('hex');

    const apiKey = ApiKey.create({
      name: `${name}-key`,
      keyHash,
      userId: user.id,
      projectId: project.id,
      expiresAt: null,
    });
    await this.#apiKeyRepo.save(apiKey);

    return {
      project,
      user,
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        token: rawToken,
      },
    };
  }
}
