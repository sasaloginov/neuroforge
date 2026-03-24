import { createHash, randomBytes } from 'node:crypto';
import { Project } from '../../src/domain/entities/Project.js';
import { User } from '../../src/domain/entities/User.js';
import { ApiKey } from '../../src/domain/entities/ApiKey.js';

/**
 * Registers a new project in the database: creates project, user, and API key.
 * Uses a DB transaction to ensure atomicity — all three inserts succeed or none do.
 *
 * Runs SQL directly on a transactional client instead of going through repos,
 * because PgProjectRepo/PgUserRepo/PgApiKeyRepo use the getPool() singleton
 * and cannot be scoped to a transaction client.
 */
export class ProjectRegistrar {
  #pool;

  /**
   * @param {{ pool: import('pg').Pool }} deps
   */
  constructor({ pool }) {
    this.#pool = pool;
  }

  /**
   * Register a project with all related entities inside a single transaction.
   * @param {{ name: string, prefix: string, repoUrl: string, workDir: string }} params
   * @returns {Promise<{ project: Project, user: User, apiKey: { id: string, name: string, token: string } }>}
   */
  async register({ name, prefix, repoUrl, workDir }) {
    const client = await this.#pool.connect();

    try {
      await client.query('BEGIN');

      // Check for duplicate name
      const { rows: byName } = await client.query(
        'SELECT id FROM projects WHERE name = $1', [name],
      );
      if (byName.length > 0) {
        throw new Error(`Project with name "${name}" already exists`);
      }

      // Check for duplicate prefix
      const normalizedPrefix = prefix.toUpperCase();
      const { rows: byPrefix } = await client.query(
        'SELECT id FROM projects WHERE prefix = $1', [normalizedPrefix],
      );
      if (byPrefix.length > 0) {
        throw new Error(`Project with prefix "${normalizedPrefix}" already exists`);
      }

      // 1. Create project entity (validates prefix format)
      const project = Project.create({ name, prefix, repoUrl, workDir });
      const pr = project.toRow();
      await client.query(
        `INSERT INTO projects (id, name, prefix, repo_url, work_dir, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [pr.id, pr.name, pr.prefix, pr.repo_url, pr.work_dir, pr.created_at],
      );

      // 2. Create user for the project
      const user = User.create({ name: `${name}-agent`, role: 'member' });
      await client.query(
        `INSERT INTO users (id, name, role, created_at)
         VALUES ($1,$2,$3,$4)`,
        [user.id, user.name, user.role, user.createdAt],
      );

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
      await client.query(
        `INSERT INTO api_keys (id, name, key_hash, user_id, project_id, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [apiKey.id, apiKey.name, apiKey.keyHash, apiKey.userId,
         apiKey.projectId, apiKey.expiresAt, apiKey.createdAt],
      );

      await client.query('COMMIT');

      return {
        project,
        user,
        apiKey: {
          id: apiKey.id,
          name: apiKey.name,
          token: rawToken,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
