import crypto from 'node:crypto';
import { ISessionRepo } from '../../domain/ports/ISessionRepo.js';
import { Session } from '../../domain/entities/Session.js';
import { getPool } from './pg.js';

export class PgSessionRepo extends ISessionRepo {
  /** @returns {Session|null} */
  async findById(id) {
    const { rows } = await getPool().query(
      'SELECT * FROM sessions WHERE id = $1',
      [id],
    );
    return rows.length ? Session.fromRow(rows[0]) : null;
  }

  /** @returns {Session|null} */
  async findByProjectAndRole(projectId, roleName) {
    const { rows } = await getPool().query(
      "SELECT * FROM sessions WHERE project_id = $1 AND role_name = $2 AND status = 'active' LIMIT 1",
      [projectId, roleName],
    );
    return rows.length ? Session.fromRow(rows[0]) : null;
  }

  /** Upsert a session. */
  async save(session) {
    const r = session.toRow();
    await getPool().query(
      `INSERT INTO sessions (id, project_id, task_id, cli_session_id, role_name, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         task_id = EXCLUDED.task_id,
         cli_session_id = EXCLUDED.cli_session_id,
         role_name = EXCLUDED.role_name,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      [r.id, r.project_id, r.task_id, r.cli_session_id, r.role_name, r.status, r.created_at, r.updated_at],
    );
  }

  /** Atomically find or create an active session for project+role. */
  async findOrCreate(projectId, roleName) {
    const client = await getPool().connect();
    const now = new Date();

    try {
      await client.query('BEGIN');

      // Lock existing active session row (if any) to prevent race conditions
      const existing = await client.query(
        `SELECT * FROM sessions
         WHERE project_id = $1 AND role_name = $2 AND status = 'active'
         LIMIT 1
         FOR UPDATE`,
        [projectId, roleName],
      );

      let row;
      if (existing.rows.length > 0) {
        const { rows } = await client.query(
          `UPDATE sessions SET updated_at = $1 WHERE id = $2 RETURNING *`,
          [now, existing.rows[0].id],
        );
        row = rows[0];
      } else {
        const id = crypto.randomUUID();
        const { rows } = await client.query(
          `INSERT INTO sessions (id, project_id, cli_session_id, role_name, status, created_at, updated_at)
           VALUES ($1, $2, NULL, $3, 'active', $4, $5)
           RETURNING *`,
          [id, projectId, roleName, now, now],
        );
        row = rows[0];
      }

      await client.query('COMMIT');
      return Session.fromRow(row);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Atomically find or create an active session for task+role. */
  async findOrCreateForTask(taskId, projectId, roleName) {
    const client = await getPool().connect();
    const now = new Date();

    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT * FROM sessions
         WHERE task_id = $1 AND role_name = $2 AND status = 'active'
         LIMIT 1
         FOR UPDATE`,
        [taskId, roleName],
      );

      let row;
      if (existing.rows.length > 0) {
        const { rows } = await client.query(
          `UPDATE sessions SET updated_at = $1 WHERE id = $2 RETURNING *`,
          [now, existing.rows[0].id],
        );
        row = rows[0];
      } else {
        const id = crypto.randomUUID();
        const { rows } = await client.query(
          `INSERT INTO sessions (id, project_id, task_id, cli_session_id, role_name, status, created_at, updated_at)
           VALUES ($1, $2, $3, NULL, $4, 'active', $5, $6)
           RETURNING *`,
          [id, projectId, taskId, roleName, now, now],
        );
        row = rows[0];
      }

      await client.query('COMMIT');
      return Session.fromRow(row);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Find active session for task+role. */
  async findByTaskAndRole(taskId, roleName) {
    const { rows } = await getPool().query(
      "SELECT * FROM sessions WHERE task_id = $1 AND role_name = $2 AND status = 'active' LIMIT 1",
      [taskId, roleName],
    );
    return rows.length ? Session.fromRow(rows[0]) : null;
  }

  async delete(id) {
    await getPool().query('DELETE FROM sessions WHERE id = $1', [id]);
  }
}
