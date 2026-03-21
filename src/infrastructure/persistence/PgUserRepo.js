import { User } from '../../domain/entities/User.js';
import { getPool } from './pg.js';

export class PgUserRepo {
  async findById(id) {
    const { rows } = await getPool().query(
      'SELECT * FROM users WHERE id = $1',
      [id],
    );
    return rows.length ? User.fromRow(rows[0]) : null;
  }

  async findByRole(role) {
    const { rows } = await getPool().query(
      'SELECT * FROM users WHERE role = $1 ORDER BY created_at',
      [role],
    );
    return rows.map(User.fromRow);
  }

  async save(user) {
    await getPool().query(
      `INSERT INTO users (id, name, role, created_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         role = EXCLUDED.role`,
      [user.id, user.name, user.role, user.createdAt],
    );
  }

  async findAll() {
    const { rows } = await getPool().query(
      'SELECT * FROM users ORDER BY created_at',
    );
    return rows.map(User.fromRow);
  }

  async delete(id) {
    await getPool().query('DELETE FROM users WHERE id = $1', [id]);
  }
}
