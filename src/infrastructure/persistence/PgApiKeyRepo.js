import { ApiKey } from '../../domain/entities/ApiKey.js';
import { getPool } from './pg.js';

export class PgApiKeyRepo {
  /** Find API key by hash (for auth lookup). */
  async findByHash(keyHash) {
    const { rows } = await getPool().query(
      'SELECT * FROM api_keys WHERE key_hash = $1',
      [keyHash],
    );
    return rows.length ? ApiKey.fromRow(rows[0]) : null;
  }

  async findById(id) {
    const { rows } = await getPool().query(
      'SELECT * FROM api_keys WHERE id = $1',
      [id],
    );
    return rows.length ? ApiKey.fromRow(rows[0]) : null;
  }

  async findByUserId(userId) {
    const { rows } = await getPool().query(
      'SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
    return rows.map(ApiKey.fromRow);
  }

  async save(apiKey) {
    await getPool().query(
      `INSERT INTO api_keys (id, name, key_hash, user_id, project_id, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         key_hash = EXCLUDED.key_hash,
         user_id = EXCLUDED.user_id,
         project_id = EXCLUDED.project_id,
         expires_at = EXCLUDED.expires_at`,
      [apiKey.id, apiKey.name, apiKey.keyHash, apiKey.userId,
       apiKey.projectId ?? null, apiKey.expiresAt ?? null, apiKey.createdAt],
    );
  }

  async delete(id) {
    await getPool().query('DELETE FROM api_keys WHERE id = $1', [id]);
  }
}
