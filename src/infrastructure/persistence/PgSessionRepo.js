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
      `INSERT INTO sessions (id, project_id, cli_session_id, role_name, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         cli_session_id = EXCLUDED.cli_session_id,
         role_name = EXCLUDED.role_name,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      [r.id, r.project_id, r.cli_session_id, r.role_name, r.status, r.created_at, r.updated_at],
    );
  }

  async delete(id) {
    await getPool().query('DELETE FROM sessions WHERE id = $1', [id]);
  }
}
