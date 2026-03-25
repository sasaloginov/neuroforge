/**
 * Port: Knowledge Graph Repository.
 * Persistence for graph entities and relations.
 *
 * @interface IKnowledgeGraphRepo
 */
export class IKnowledgeGraphRepo {
  /**
   * Upsert an entity (insert or update on conflict by project+type+normalizedName).
   * @param {import('../valueObjects/KGEntity.js').KGEntity} entity
   * @returns {Promise<import('../valueObjects/KGEntity.js').KGEntity>}
   */
  async upsertEntity(_entity) { throw new Error('Not implemented'); }

  /**
   * Upsert a relation (insert or update on conflict by source+target+type).
   * @param {import('../valueObjects/KGRelation.js').KGRelation} relation
   * @returns {Promise<import('../valueObjects/KGRelation.js').KGRelation>}
   */
  async upsertRelation(_relation) { throw new Error('Not implemented'); }

  /**
   * Find entities matching text query (FTS + ILIKE).
   * @param {string} projectId
   * @param {string} text
   * @returns {Promise<import('../valueObjects/KGEntity.js').KGEntity[]>}
   */
  async findEntitiesByText(_projectId, _text) { throw new Error('Not implemented'); }

  /**
   * Find entities by normalized names.
   * @param {string} projectId
   * @param {string[]} names - Normalized names to look up
   * @returns {Promise<import('../valueObjects/KGEntity.js').KGEntity[]>}
   */
  async findEntitiesByNormalizedName(_projectId, _names) { throw new Error('Not implemented'); }

  /**
   * Traverse graph from seed entities up to given depth.
   * Returns connected entities, relations, and linked memory IDs ranked by graph proximity.
   * @param {string} projectId
   * @param {string[]} entityIds - Seed entity UUIDs
   * @param {number} [depth=2] - Max traversal depth
   * @param {number} [limit=20] - Max results
   * @returns {Promise<{entities: import('../valueObjects/KGEntity.js').KGEntity[], relations: import('../valueObjects/KGRelation.js').KGRelation[], memoryIds: string[]}>}
   */
  async traverse(_projectId, _entityIds, _depth, _limit) { throw new Error('Not implemented'); }

  /**
   * Get all relations for a specific entity.
   * @param {string} entityId
   * @returns {Promise<import('../valueObjects/KGRelation.js').KGRelation[]>}
   */
  async getEntityRelations(_entityId) { throw new Error('Not implemented'); }

  /**
   * Get project graph overview.
   * @param {string} projectId
   * @param {object} [options]
   * @param {number} [options.limit]
   * @param {string[]} [options.entityTypes]
   * @returns {Promise<{entities: import('../valueObjects/KGEntity.js').KGEntity[], relations: import('../valueObjects/KGRelation.js').KGRelation[]}>}
   */
  async getProjectGraph(_projectId, _options) { throw new Error('Not implemented'); }
}
