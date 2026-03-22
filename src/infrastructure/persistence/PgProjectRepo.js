import { IProjectRepo } from '../../domain/ports/IProjectRepo.js';
import { Project } from '../../domain/entities/Project.js';
import { getPool } from './pg.js';

export class PgProjectRepo extends IProjectRepo {
  async findById(id) {
    const { rows } = await getPool().query(
      'SELECT * FROM projects WHERE id = $1',
      [id],
    );
    return rows.length ? Project.fromRow(rows[0]) : null;
  }

  async findByName(name) {
    const { rows } = await getPool().query(
      'SELECT * FROM projects WHERE name = $1',
      [name],
    );
    return rows.length ? Project.fromRow(rows[0]) : null;
  }

  async findByPrefix(prefix) {
    const { rows } = await getPool().query(
      'SELECT * FROM projects WHERE prefix = $1',
      [prefix],
    );
    return rows.length ? Project.fromRow(rows[0]) : null;
  }

  async save(project) {
    const r = project.toRow();
    await getPool().query(
      `INSERT INTO projects (id, name, prefix, repo_url, work_dir, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         prefix = EXCLUDED.prefix,
         repo_url = EXCLUDED.repo_url,
         work_dir = EXCLUDED.work_dir`,
      [r.id, r.name, r.prefix, r.repo_url, r.work_dir, r.created_at],
    );
  }

  async findAll() {
    const { rows } = await getPool().query(
      'SELECT * FROM projects ORDER BY created_at',
    );
    return rows.map(Project.fromRow);
  }
}
