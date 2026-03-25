import { randomUUID } from 'node:crypto';

/**
 * Valid relation types for Knowledge Graph edges.
 */
export const RELATION_TYPES = [
  'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DECIDED', 'CAUSED_BY', 'RESOLVED_BY', 'RELATES_TO',
];

/**
 * KGRelation — value object representing an edge in the Knowledge Graph.
 */
export class KGRelation {
  /**
   * @param {object} props
   * @param {string} props.id
   * @param {string} props.projectId
   * @param {string} props.sourceEntityId
   * @param {string} props.targetEntityId
   * @param {string} props.relationType
   * @param {number} [props.confidence]
   * @param {string|null} [props.memoryId]
   * @param {object} [props.properties]
   * @param {Date} [props.createdAt]
   */
  constructor({ id, projectId, sourceEntityId, targetEntityId, relationType, confidence = 0.8, memoryId = null, properties = {}, createdAt = new Date() }) {
    this.id = id;
    this.projectId = projectId;
    this.sourceEntityId = sourceEntityId;
    this.targetEntityId = targetEntityId;
    this.relationType = relationType;
    this.confidence = confidence;
    this.memoryId = memoryId;
    this.properties = properties;
    this.createdAt = createdAt;
  }

  /**
   * Factory: create a new KGRelation with generated ID.
   * @param {object} props
   * @param {string} props.projectId
   * @param {string} props.sourceEntityId
   * @param {string} props.targetEntityId
   * @param {string} props.relationType
   * @param {number} [props.confidence]
   * @param {string|null} [props.memoryId]
   * @param {object} [props.properties]
   * @returns {KGRelation}
   */
  static create({ projectId, sourceEntityId, targetEntityId, relationType, confidence, memoryId, properties }) {
    if (!projectId) throw new Error('KGRelation requires projectId');
    if (!sourceEntityId || !targetEntityId) throw new Error('KGRelation requires sourceEntityId and targetEntityId');
    if (!RELATION_TYPES.includes(relationType)) {
      throw new Error(`Invalid relation type: ${relationType}. Valid: ${RELATION_TYPES.join(', ')}`);
    }
    const clampedConfidence = typeof confidence === 'number'
      ? Math.max(0, Math.min(1, confidence))
      : 0.8;

    return new KGRelation({
      id: randomUUID(),
      projectId,
      sourceEntityId,
      targetEntityId,
      relationType,
      confidence: clampedConfidence,
      memoryId: memoryId || null,
      properties: properties || {},
    });
  }

  /**
   * Reconstitute from a database row.
   * @param {object} row
   * @returns {KGRelation}
   */
  static fromRow(row) {
    return new KGRelation({
      id: row.id,
      projectId: row.project_id,
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      relationType: row.relation_type,
      confidence: parseFloat(row.confidence),
      memoryId: row.memory_id || null,
      properties: typeof row.properties === 'string' ? JSON.parse(row.properties) : (row.properties || {}),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    });
  }
}
