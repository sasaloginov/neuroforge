import { KGEntity } from '../valueObjects/KGEntity.js';
import { KGRelation } from '../valueObjects/KGRelation.js';

/**
 * KnowledgeGraphService — orchestrates KG extraction and graph-based retrieval.
 * Depends only on domain ports (IKnowledgeGraphRepo, IKGEntityExtractor).
 */
export class KnowledgeGraphService {
  #knowledgeGraphRepo;
  #kgEntityExtractor;
  #logger;

  /**
   * @param {object} deps
   * @param {import('../ports/IKnowledgeGraphRepo.js').IKnowledgeGraphRepo} deps.knowledgeGraphRepo
   * @param {import('../ports/IKGEntityExtractor.js').IKGEntityExtractor} deps.kgEntityExtractor
   * @param {object} [deps.logger]
   */
  constructor({ knowledgeGraphRepo, kgEntityExtractor, logger }) {
    this.#knowledgeGraphRepo = knowledgeGraphRepo;
    this.#kgEntityExtractor = kgEntityExtractor;
    this.#logger = logger || console;
  }

  /**
   * Extract entities and relations from text and store in graph.
   * @param {string} projectId
   * @param {string} text - Source text (agent response)
   * @param {string[]} memoryIds - Associated memory IDs for linking
   * @returns {Promise<{entitiesCount: number, relationsCount: number}>}
   */
  async extractAndStore(projectId, text, memoryIds = []) {
    const extracted = await this.#kgEntityExtractor.extractEntities(text);

    if (!extracted.entities || extracted.entities.length === 0) {
      return { entitiesCount: 0, relationsCount: 0 };
    }

    // Upsert entities and build name→ID map
    const entityMap = new Map();
    for (const raw of extracted.entities) {
      const entity = KGEntity.create({
        projectId,
        entityType: raw.type,
        name: raw.name,
        properties: raw.properties,
      });

      const saved = await this.#knowledgeGraphRepo.upsertEntity(entity);
      entityMap.set(raw.name.toLowerCase(), saved);
    }

    // Upsert relations, resolving names to entity IDs
    let relationsCount = 0;
    const primaryMemoryId = memoryIds.length > 0 ? memoryIds[0] : null;

    for (const raw of (extracted.relations || [])) {
      const sourceEntity = entityMap.get(raw.source.toLowerCase());
      const targetEntity = entityMap.get(raw.target.toLowerCase());

      if (!sourceEntity || !targetEntity) {
        this.#logger.log('[KG] Skipping relation %s→%s: entity not found', raw.source, raw.target);
        continue;
      }

      const relation = KGRelation.create({
        projectId,
        sourceEntityId: sourceEntity.id,
        targetEntityId: targetEntity.id,
        relationType: raw.type,
        confidence: raw.confidence,
        memoryId: primaryMemoryId,
        properties: raw.properties,
      });

      await this.#knowledgeGraphRepo.upsertRelation(relation);
      relationsCount++;
    }

    this.#logger.log('[KG] Stored %d entities, %d relations for project %s',
      entityMap.size, relationsCount, projectId);

    return { entitiesCount: entityMap.size, relationsCount };
  }

  /**
   * Find memories related to query via graph traversal.
   * Uses keyword matching (not LLM) for speed.
   * @param {string} projectId
   * @param {string} queryText
   * @param {number} [limit=10]
   * @returns {Promise<{memoryIds: string[], graphContext: string}>}
   */
  async findRelatedMemories(projectId, queryText, limit = 10) {
    if (!queryText || !queryText.trim()) {
      return { memoryIds: [], graphContext: '' };
    }

    // Find seed entities by text matching
    const seedEntities = await this.#knowledgeGraphRepo.findEntitiesByText(projectId, queryText);

    if (seedEntities.length === 0) {
      return { memoryIds: [], graphContext: '' };
    }

    const seedIds = seedEntities.map(e => e.id);

    // Traverse graph (1-2 hops)
    const { entities, relations, memoryIds } = await this.#knowledgeGraphRepo.traverse(
      projectId, seedIds, 2, limit * 2
    );

    // Format graph context for prompt injection
    const graphContext = this.#formatGraphContext(seedEntities, entities, relations);

    return { memoryIds: memoryIds.slice(0, limit), graphContext };
  }

  /**
   * Format graph context as XML for prompt injection.
   * @param {KGEntity[]} seedEntities
   * @param {KGEntity[]} allEntities
   * @param {KGRelation[]} relations
   * @returns {string}
   */
  #formatGraphContext(seedEntities, allEntities, relations) {
    if (allEntities.length === 0) return '';

    const entityById = new Map(allEntities.map(e => [e.id, e]));

    // Group relations by source entity
    const lines = [];
    for (const entity of seedEntities) {
      const entityRelations = relations.filter(
        r => r.sourceEntityId === entity.id || r.targetEntityId === entity.id
      );

      if (entityRelations.length === 0) continue;

      const relLines = entityRelations.map(r => {
        const targetId = r.sourceEntityId === entity.id ? r.targetEntityId : r.sourceEntityId;
        const target = entityById.get(targetId);
        const targetName = target ? target.name : 'unknown';
        return `    <relation type="${r.relationType}" target="${this.#escapeXml(targetName)}" confidence="${r.confidence.toFixed(1)}"/>`;
      });

      lines.push(`  <entity name="${this.#escapeXml(entity.name)}" type="${entity.entityType}">`);
      lines.push(...relLines);
      lines.push('  </entity>');
    }

    return lines.join('\n');
  }

  #escapeXml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
