import { ITaskRepo } from '../../domain/ports/ITaskRepo.js';
import { Task } from '../../domain/entities/Task.js';
import { getPool } from './pg.js';

export class PgTaskRepo extends ITaskRepo {
  /** @returns {Task|null} */
  async findById(id) {
    const { rows } = await getPool().query(
      'SELECT * FROM tasks WHERE id = $1',
      [id],
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
    const { rows } = await getPool().query(sql, params);
    return rows.map(Task.fromRow);
  }

  /** Upsert a task. */
  async save(task) {
    const r = task.toRow();
    await getPool().query(
      `INSERT INTO tasks (id, project_id, title, description, status, callback_url, callback_meta, revision_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         callback_url = EXCLUDED.callback_url,
         callback_meta = EXCLUDED.callback_meta,
         revision_count = EXCLUDED.revision_count,
         updated_at = EXCLUDED.updated_at`,
      [r.id, r.project_id, r.title, r.description, r.status, r.callback_url,
       r.callback_meta ? JSON.stringify(r.callback_meta) : null,
       r.revision_count, r.created_at, r.updated_at],
    );
  }

  async delete(id) {
    await getPool().query('DELETE FROM tasks WHERE id = $1', [id]);
  }
}
