import { ITaskRepo } from '../../domain/ports/ITaskRepo.js';
import { Task } from '../../domain/entities/Task.js';
import { getPool } from './pg.js';

export class PgTaskRepo extends ITaskRepo {
  /** @param {{ pool?: import('pg').Pool }} [options] */
  constructor({ pool } = {}) {
    super();
    this._pool = pool;
  }

  /** @returns {import('pg').Pool} */
  _getPool() {
    return this._pool || getPool();
  }

  /** @returns {Task|null} */
  async findById(id) {
    const { rows } = await this._getPool().query(
      `SELECT t.*, p.prefix AS project_prefix
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id = $1`,
      [id],
    );
    return rows.length ? Task.fromRow(rows[0]) : null;
  }

  /**
   * @param {string} projectId
   * @param {number} seqNumber
   * @returns {Task|null}
   */
  async findByProjectIdAndSeq(projectId, seqNumber) {
    const { rows } = await this._getPool().query(
      'SELECT * FROM tasks WHERE project_id = $1 AND seq_number = $2',
      [projectId, seqNumber],
    );
    return rows.length ? Task.fromRow(rows[0]) : null;
  }

  /**
   * @param {string} projectId
   * @param {{ status?: string }} [filters]
   * @returns {Task[]}
   */
  async findByProjectId(projectId, filters = {}) {
    let sql = 'SELECT * FROM tasks WHERE project_id = $1';
    const params = [projectId];

    if (filters.status) {
      params.push(filters.status);
      sql += ` AND status = $${params.length}`;
    }

    sql += ' ORDER BY created_at';
    const { rows } = await this._getPool().query(sql, params);
    return rows.map(Task.fromRow);
  }

  /**
   * Atomically assign next seq_number and insert task in a single transaction.
   *
   * Locks the parent project row (FOR UPDATE) to serialise concurrent inserts,
   * then computes MAX(seq_number)+1 in a separate query (aggregates cannot use
   * FOR UPDATE in PostgreSQL).
   *
   * Mutates `task.seqNumber` in place and returns the task for convenience.
   *
   * @param {Task} task
   * @returns {Task} — the same task instance with seqNumber assigned
   */
  async saveWithSeqNumber(task) {
    const pool = this._getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the project row to prevent concurrent seq_number collisions.
      // FOR UPDATE on aggregates is illegal in PG, so we lock the parent row instead.
      await client.query(
        'SELECT id FROM projects WHERE id = $1 FOR UPDATE',
        [task.projectId],
      );

      // Compute next seq_number (safe — no concurrent insert can interleave now)
      const { rows: seqRows } = await client.query(
        'SELECT COALESCE(MAX(seq_number), 0) + 1 AS next_seq FROM tasks WHERE project_id = $1',
        [task.projectId],
      );
      task.seqNumber = seqRows[0].next_seq;

      const r = task.toRow();
      await client.query(
        `INSERT INTO tasks (id, project_id, title, description, status, callback_url, callback_meta, revision_count, seq_number, branch_name, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [r.id, r.project_id, r.title, r.description, r.status, r.callback_url,
         r.callback_meta ? JSON.stringify(r.callback_meta) : null,
         r.revision_count, r.seq_number, r.branch_name, r.created_at, r.updated_at],
      );

      await client.query('COMMIT');
      return task;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Upsert a task. */
  async save(task) {
    const r = task.toRow();
    await this._getPool().query(
      `INSERT INTO tasks (id, project_id, title, description, status, callback_url, callback_meta, revision_count, seq_number, branch_name, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         callback_url = EXCLUDED.callback_url,
         callback_meta = EXCLUDED.callback_meta,
         revision_count = EXCLUDED.revision_count,
         seq_number = EXCLUDED.seq_number,
         branch_name = EXCLUDED.branch_name,
         updated_at = EXCLUDED.updated_at`,
      [r.id, r.project_id, r.title, r.description, r.status, r.callback_url,
       r.callback_meta ? JSON.stringify(r.callback_meta) : null,
       r.revision_count, r.seq_number, r.branch_name, r.created_at, r.updated_at],
    );
  }

  async delete(id) {
    await this._getPool().query('DELETE FROM tasks WHERE id = $1', [id]);
  }

  /**
   * Check if project has any active (non-terminal, non-pending/backlog) task.
   * @param {string} projectId
   * @returns {boolean}
   */
  async hasActiveTask(projectId) {
    const { rows } = await this._getPool().query(
      `SELECT EXISTS(
        SELECT 1 FROM tasks
        WHERE project_id = $1
          AND status IN ('in_progress', 'waiting_reply', 'needs_escalation')
      ) AS active`,
      [projectId],
    );
    return rows[0].active;
  }

  /**
   * Find the oldest pending task for a project.
   * @param {string} projectId
   * @returns {Task|null}
   */
  async findOldestPending(projectId) {
    const { rows } = await this._getPool().query(
      `SELECT t.*, p.prefix AS project_prefix
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.project_id = $1 AND t.status = 'pending'
       ORDER BY t.created_at ASC
       LIMIT 1`,
      [projectId],
    );
    return rows.length ? Task.fromRow(rows[0]) : null;
  }
}
