/**
 * PgKnowledgeGraphRepo — implements IKnowledgeGraphRepo.
 * PostgreSQL-based Knowledge Graph with recursive CTE traversal.
 */
import { getPool } from './pg.js';
import { KGEntity } from '../../domain/valueObjects/KGEntity.js';
import { KGRelation } from '../../domain/valueObjects/KGRelation.js';

export class PgKnowledgeGraphRepo {
  /**
   * @param {import('pg').Pool} [pool]
   */
  constructor(pool = null) {
    this._pool = pool;
  }

  /** @returns {import('pg').Pool} */
  get pool() {
    return this._pool || getPool();
  }

  /**
   * Upsert entity — insert or merge properties on conflict.
   * @param {KGEntity} entity
   * @returns {Promise<KGEntity>}
   */
  async upsertEntity(entity) {
    const { rows } = await this.pool.query(
      `INSERT INTO kg_entities (id, project_id, entity_type, name, normalized_name, properties)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, entity_type, normalized_name)
       DO UPDATE SET
         properties = kg_entities.properties || EXCLUDED.properties,
         updated_at = NOW()
       RETURNING *`,
      [entity.id, entity.projectId, entity.entityType, entity.name, entity.normalizedName, JSON.stringify(entity.properties)]
    );
    return KGEntity.fromRow(rows[0]);
  }

  /**
   * Upsert relation — insert or update confidence/memory on conflict.
   * @param {KGRelation} relation
   * @returns {Promise<KGRelation>}
   */
  async upsertRelation(relation) {
    const { rows } = await this.pool.query(
      `INSERT INTO kg_relations (id, project_id, source_entity_id, target_entity_id, relation_type, confidence, memory_id, properties)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source_entity_id, target_entity_id, relation_type)
       DO UPDATE SET
         confidence = GREATEST(kg_relations.confidence, EXCLUDED.confidence),
         memory_id = COALESCE(EXCLUDED.memory_id, kg_relations.memory_id),
         properties = kg_relations.properties || EXCLUDED.properties
       RETURNING *`,
      [relation.id, relation.projectId, relation.sourceEntityId, relation.targetEntityId, relation.relationType, relation.confidence, relation.memoryId, JSON.stringify(relation.properties)]
    );
    return KGRelation.fromRow(rows[0]);
  }

  /**
   * Find entities by text — FTS on name + ILIKE fallback.
   * @param {string} projectId
   * @param {string} text
   * @returns {Promise<KGEntity[]>}
   */
  async findEntitiesByText(projectId, text) {
    if (!text || !text.trim()) return [];

    const words = text.trim().split(/\s+/).filter(w => w.length >= 2);
    if (words.length === 0) return [];

    // Try FTS first, then ILIKE fallback for each word
    const { rows } = await this.pool.query(
      `SELECT DISTINCT e.* FROM kg_entities e
       WHERE e.project_id = $1
         AND (
           to_tsvector('simple', e.name) @@ to_tsquery('simple', $2)
           OR e.normalized_name = ANY($3)
           OR e.name ILIKE ANY($4)
         )
       LIMIT 20`,
      [
        projectId,
        words.join(' & '),
        words.map(w => KGEntity.normalizeName(w)),
        words.map(w => `%${w}%`),
      ]
    );
    return rows.map(KGEntity.fromRow);
  }

  /**
   * Find entities by normalized names.
   * @param {string} projectId
   * @param {string[]} names
   * @returns {Promise<KGEntity[]>}
   */
  async findEntitiesByNormalizedName(projectId, names) {
    if (!names || names.length === 0) return [];

    const { rows } = await this.pool.query(
      `SELECT * FROM kg_entities WHERE project_id = $1 AND normalized_name = ANY($2)`,
      [projectId, names]
    );
    return rows.map(KGEntity.fromRow);
  }

  /**
   * Traverse graph from seed entities using recursive CTE.
   * @param {string} projectId
   * @param {string[]} entityIds
   * @param {number} [depth=2]
   * @param {number} [limit=20]
   * @returns {Promise<{entities: KGEntity[], relations: KGRelation[], memoryIds: string[]}>}
   */
  async traverse(projectId, entityIds, depth = 2, limit = 20) {
    if (!entityIds || entityIds.length === 0) {
      return { entities: [], relations: [], memoryIds: [] };
    }

    // Get connected entities via recursive CTE
    const { rows: entityRows } = await this.pool.query(
      `WITH RECURSIVE graph_walk AS (
        SELECT e.id, e.name, e.entity_type, e.project_id, e.normalized_name,
               e.properties, e.created_at, e.updated_at,
               0 AS depth, ARRAY[e.id] AS path
        FROM kg_entities e
        WHERE e.id = ANY($1) AND e.project_id = $2

        UNION ALL

        SELECT e2.id, e2.name, e2.entity_type, e2.project_id, e2.normalized_name,
               e2.properties, e2.created_at, e2.updated_at,
               gw.depth + 1, gw.path || e2.id
        FROM graph_walk gw
        JOIN kg_relations r ON r.source_entity_id = gw.id OR r.target_entity_id = gw.id
        JOIN kg_entities e2 ON e2.id = CASE
          WHEN r.source_entity_id = gw.id THEN r.target_entity_id
          ELSE r.source_entity_id
        END
        WHERE gw.depth < $3
          AND NOT (e2.id = ANY(gw.path))
          AND r.confidence >= 0.5
          AND e2.project_id = $2
      )
      SELECT DISTINCT ON (id) * FROM graph_walk
      ORDER BY id, depth ASC
      LIMIT $4`,
      [entityIds, projectId, depth, limit]
    );

    const allEntityIds = entityRows.map(r => r.id);
    if (allEntityIds.length === 0) {
      return { entities: [], relations: [], memoryIds: [] };
    }

    // Get relations between discovered entities
    const { rows: relationRows } = await this.pool.query(
      `SELECT * FROM kg_relations
       WHERE project_id = $1
         AND source_entity_id = ANY($2)
         AND target_entity_id = ANY($2)`,
      [projectId, allEntityIds]
    );

    // Collect unique memory IDs from relations
    const memoryIds = [...new Set(
      relationRows
        .filter(r => r.memory_id)
        .map(r => r.memory_id)
    )];

    return {
      entities: entityRows.map(KGEntity.fromRow),
      relations: relationRows.map(KGRelation.fromRow),
      memoryIds,
    };
  }

  /**
   * Get all relations for a specific entity.
   * @param {string} entityId
   * @returns {Promise<KGRelation[]>}
   */
  async getEntityRelations(entityId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM kg_relations
       WHERE source_entity_id = $1 OR target_entity_id = $1
       ORDER BY confidence DESC`,
      [entityId]
    );
    return rows.map(KGRelation.fromRow);
  }

  /**
   * Get project graph overview.
   * @param {string} projectId
   * @param {object} [options]
   * @param {number} [options.limit=100]
   * @param {string[]} [options.entityTypes]
   * @returns {Promise<{entities: KGEntity[], relations: KGRelation[]}>}
   */
  async getProjectGraph(projectId, options = {}) {
    const { limit = 100, entityTypes } = options;

    let entityQuery = 'SELECT * FROM kg_entities WHERE project_id = $1';
    const entityParams = [projectId];

    if (entityTypes && entityTypes.length > 0) {
      entityQuery += ' AND entity_type = ANY($2)';
      entityParams.push(entityTypes);
    }
    entityQuery += ` ORDER BY updated_at DESC LIMIT $${entityParams.length + 1}`;
    entityParams.push(limit);

    const { rows: entityRows } = await this.pool.query(entityQuery, entityParams);
    const entityIds = entityRows.map(e => e.id);

    let relations = [];
    if (entityIds.length > 0) {
      const { rows: relationRows } = await this.pool.query(
        `SELECT * FROM kg_relations
         WHERE project_id = $1
           AND source_entity_id = ANY($2)
           AND target_entity_id = ANY($2)`,
        [projectId, entityIds]
      );
      relations = relationRows.map(KGRelation.fromRow);
    }

    return {
      entities: entityRows.map(KGEntity.fromRow),
      relations,
    };
  }
}
