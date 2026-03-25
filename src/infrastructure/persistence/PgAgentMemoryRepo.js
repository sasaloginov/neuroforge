/**
 * PgAgentMemoryRepo — implements IAgentMemoryRepo.
 * PostgreSQL + pgvector hybrid search (vector cosine + FTS + RRF).
 */
import pgvector from 'pgvector';
import { getPool } from './pg.js';
import { AgentMemory } from '../../domain/entities/AgentMemory.js';

export class PgAgentMemoryRepo {
  /**
   * Convert Float32Array to plain Array for pgvector.
   * @param {Float32Array|number[]} embedding
   * @returns {string}
   */
  static #toSql(embedding) {
    const arr = embedding instanceof Float32Array ? Array.from(embedding) : embedding;
    return pgvector.toSql(arr);
  }

  /**
   * @param {import('pg').Pool} [pool]
   * @param {object} [options]
   * @param {number} [options.rrfK=60] - RRF smoothing constant
   * @param {number} [options.searchPoolMultiplier=3]
   */
  constructor(pool = null, options = {}) {
    this._pool = pool;
    this._rrfK = options.rrfK ?? 60;
    this._searchPoolMultiplier = options.searchPoolMultiplier ?? 3;
  }

  /** @returns {import('pg').Pool} */
  get pool() {
    return this._pool || getPool();
  }

  /**
   * Save a new agent memory.
   * @param {AgentMemory} memory
   * @returns {Promise<void>}
   */
  async save(memory) {
    await this.pool.query(
      `INSERT INTO agent_memories
        (id, project_id, task_id, role, section, content, embedding, importance,
         access_count, metadata, created_at, last_accessed, archived)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        memory.id,
        memory.projectId,
        memory.taskId,
        memory.role,
        memory.section,
        memory.content,
        PgAgentMemoryRepo.#toSql(memory.embedding),
        memory.importance,
        memory.accessCount,
        JSON.stringify(memory.metadata),
        memory.createdAt,
        memory.lastAccessed,
        memory.archived,
      ]
    );
  }

  /**
   * Hybrid search: vector + FTS + RRF fusion.
   * @param {string} projectId
   * @param {Float32Array} embedding
   * @param {object} [options]
   * @param {number} [options.limit=5]
   * @param {string[]} [options.sections]
   * @param {string} [options.queryText]
   * @param {number} [options.minScore=0]
   * @returns {Promise<AgentMemory[]>}
   */
  async search(projectId, embedding, options = {}) {
    const { limit = 5, sections, queryText = '', minScore = 0 } = options;

    const tsQuery = queryText?.trim() || null;
    const hasTextQuery = tsQuery !== null;
    const poolSize = Math.max(limit * this._searchPoolMultiplier, 30);
    const k = this._rrfK;

    // Build params
    const params = [projectId, PgAgentMemoryRepo.#toSql(embedding), poolSize];
    let paramIdx = 4;

    let sectionFilter = '';
    if (sections && sections.length > 0) {
      sectionFilter = `AND section = ANY($${paramIdx})`;
      params.push(sections);
      paramIdx++;
    }

    let tsQueryParam = null;
    if (hasTextQuery) {
      params.push(tsQuery);
      tsQueryParam = `$${paramIdx}`;
      paramIdx++;
    }

    const sql = this.#buildHybridSQL(sectionFilter, tsQueryParam, hasTextQuery, k, limit, minScore);
    const { rows } = await this.pool.query(sql, params);
    return rows.map(AgentMemory.fromRow);
  }

  /**
   * Build hybrid search SQL.
   */
  #buildHybridSQL(sectionFilter, tsQueryParam, hasTextQuery, k, limit, minScore) {
    const baseFilter = `
      WHERE project_id = $1
        AND archived = false
        AND superseded_by IS NULL
        ${sectionFilter}
    `;

    const vectorCTE = `
      vector_ranked AS (
        SELECT id,
          ROW_NUMBER() OVER (ORDER BY embedding <=> $2 ASC) AS rank_vec
        FROM agent_memories
        ${baseFilter}
        ORDER BY embedding <=> $2 ASC
        LIMIT $3
      )
    `;

    let textCTE = '';
    let rrfFormula;

    if (hasTextQuery) {
      textCTE = `,
      text_ranked AS (
        SELECT id,
          ROW_NUMBER() OVER (
            ORDER BY ts_rank_cd(tsv, plainto_tsquery('russian', ${tsQueryParam})
                                     || plainto_tsquery('simple', ${tsQueryParam})) DESC
          ) AS rank_fts
        FROM agent_memories
        ${baseFilter}
          AND tsv @@ (plainto_tsquery('russian', ${tsQueryParam})
                      || plainto_tsquery('simple', ${tsQueryParam}))
        ORDER BY ts_rank_cd(tsv, plainto_tsquery('russian', ${tsQueryParam})
                                 || plainto_tsquery('simple', ${tsQueryParam})) DESC
        LIMIT $3
      )
      `;
      rrfFormula = `
        COALESCE(1.0 / (${k} + vr.rank_vec), 0) +
        COALESCE(1.0 / (${k} + tr.rank_fts), 0)
      `;
    } else {
      rrfFormula = `1.0 / (${k} + vr.rank_vec)`;
    }

    const recencyFactor = `GREATEST(0.5, 1.0 - EXTRACT(EPOCH FROM (NOW() - m.last_accessed)) / (30 * 86400))`;
    const accessBoost = `(1.0 + 0.5 * LEAST(1.0, LN(m.access_count + 1) / LN(100)))`;

    let joinClause;
    if (hasTextQuery) {
      joinClause = `
        FROM vector_ranked vr
        FULL OUTER JOIN text_ranked tr ON vr.id = tr.id
        JOIN agent_memories m ON m.id = COALESCE(vr.id, tr.id)
      `;
    } else {
      joinClause = `
        FROM vector_ranked vr
        JOIN agent_memories m ON m.id = vr.id
      `;
    }

    const innerQuery = `
      WITH ${vectorCTE}${textCTE}
      SELECT m.*,
        (${rrfFormula}) AS rrf_score,
        (${recencyFactor}) AS recency_factor,
        ${accessBoost} AS access_boost,
        (${rrfFormula}) * (${recencyFactor}) * m.importance * ${accessBoost} AS composite_score
      ${joinClause}
    `;

    if (minScore > 0) {
      return `SELECT * FROM (${innerQuery}) AS scored
        WHERE composite_score >= ${minScore}
        ORDER BY composite_score DESC
        LIMIT ${limit}`;
    }

    return `${innerQuery}
      ORDER BY composite_score DESC
      LIMIT ${limit}`;
  }

  /**
   * Record memory access.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async updateAccess(id) {
    await this.pool.query(
      `UPDATE agent_memories
       SET access_count = access_count + 1, last_accessed = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  /**
   * Find similar memories for deduplication.
   * @param {string} projectId
   * @param {Float32Array} embedding
   * @param {number} threshold - Minimum cosine similarity
   * @returns {Promise<AgentMemory[]>}
   */
  async findSimilar(projectId, embedding, threshold = 0.90) {
    const { rows } = await this.pool.query(
      `SELECT *, 1 - (embedding <=> $2) AS similarity
       FROM agent_memories
       WHERE project_id = $1
         AND NOT archived
         AND superseded_by IS NULL
         AND 1 - (embedding <=> $2) >= $3
       ORDER BY similarity DESC
       LIMIT 5`,
      [projectId, PgAgentMemoryRepo.#toSql(embedding), threshold]
    );
    return rows.map(AgentMemory.fromRow);
  }

  /**
   * Find memories by IDs.
   * @param {string[]} ids
   * @returns {Promise<AgentMemory[]>}
   */
  async findByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const { rows } = await this.pool.query(
      'SELECT * FROM agent_memories WHERE id = ANY($1)',
      [ids]
    );
    return rows.map(AgentMemory.fromRow);
  }

  /**
   * Archive a memory (soft delete).
   * @param {string} id
   * @returns {Promise<void>}
   */
  async archive(id) {
    await this.pool.query(
      'UPDATE agent_memories SET archived = true WHERE id = $1',
      [id]
    );
  }

  /**
   * Get memories that have decayed below archive threshold.
   * @param {string} projectId
   * @param {number} decayFactor
   * @param {number} archiveThreshold
   * @returns {Promise<AgentMemory[]>}
   */
  async getDecayCandidates(projectId, decayFactor, archiveThreshold) {
    const { rows } = await this.pool.query(
      `SELECT *
       FROM agent_memories
       WHERE project_id = $1
         AND NOT archived
         AND importance * POWER($2::double precision,
             EXTRACT(EPOCH FROM (NOW() - last_accessed)) / 86400) < $3
       ORDER BY last_accessed ASC`,
      [projectId, decayFactor, archiveThreshold]
    );
    return rows.map(AgentMemory.fromRow);
  }
}
