import { IRunRepo } from '../../domain/ports/IRunRepo.js';
import { Run } from '../../domain/entities/Run.js';
import { getPool } from './pg.js';

export class PgRunRepo extends IRunRepo {
  /** @returns {Run|null} */
  async findById(id) {
    const { rows } = await getPool().query(
      'SELECT * FROM runs WHERE id = $1',
      [id],
    );
    return rows.length ? Run.fromRow(rows[0]) : null;
  }

  /** @returns {Run[]} */
  async findByTaskId(taskId) {
    const { rows } = await getPool().query(
      'SELECT * FROM runs WHERE task_id = $1 ORDER BY created_at',
      [taskId],
    );
    return rows.map(Run.fromRow);
  }

  /** @returns {Run[]} — all runs with status 'running' */
  async findRunning() {
    const { rows } = await getPool().query(
      "SELECT * FROM runs WHERE status = 'running' ORDER BY started_at",
    );
    return rows.map(Run.fromRow);
  }

  /** Upsert a run. */
  async save(run) {
    const r = run.toRow();
    await getPool().query(
      `INSERT INTO runs (id, session_id, task_id, step_id, role_name, prompt, response, status, callback_url, callback_meta, started_at, finished_at, duration_ms, error, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         session_id = EXCLUDED.session_id,
         task_id = EXCLUDED.task_id,
         step_id = EXCLUDED.step_id,
         role_name = EXCLUDED.role_name,
         prompt = EXCLUDED.prompt,
         response = EXCLUDED.response,
         status = EXCLUDED.status,
         callback_url = EXCLUDED.callback_url,
         callback_meta = EXCLUDED.callback_meta,
         started_at = EXCLUDED.started_at,
         finished_at = EXCLUDED.finished_at,
         duration_ms = EXCLUDED.duration_ms,
         error = EXCLUDED.error`,
      [r.id, r.session_id, r.task_id, r.step_id, r.role_name, r.prompt,
       r.response, r.status, r.callback_url,
       r.callback_meta ? JSON.stringify(r.callback_meta) : null,
       r.started_at, r.finished_at, r.duration_ms, r.error, r.created_at],
    );
  }

  /**
   * Atomically dequeue next queued run (FOR UPDATE SKIP LOCKED).
   * Transitions status to 'running' and sets started_at.
   * @returns {Run|null}
   */
  async takeNext() {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT * FROM runs
         WHERE status = 'queued'
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );

      if (!rows.length) {
        await client.query('COMMIT');
        return null;
      }

      const now = new Date();
      await client.query(
        `UPDATE runs SET status = 'running', started_at = $1 WHERE id = $2`,
        [now, rows[0].id],
      );

      await client.query('COMMIT');

      rows[0].status = 'running';
      rows[0].started_at = now;
      return Run.fromRow(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
