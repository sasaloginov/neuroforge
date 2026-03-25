import { randomUUID } from 'node:crypto';

/**
 * Valid entity types for Knowledge Graph nodes.
 */
export const ENTITY_TYPES = [
  'module', 'concept', 'decision', 'technology', 'pattern', 'problem', 'person',
];

/**
 * KGEntity — value object representing a node in the Knowledge Graph.
 */
export class KGEntity {
  /**
   * @param {object} props
   * @param {string} props.id
   * @param {string} props.projectId
   * @param {string} props.entityType
   * @param {string} props.name
   * @param {string} props.normalizedName
   * @param {object} [props.properties]
   * @param {Date} [props.createdAt]
   * @param {Date} [props.updatedAt]
   */
  constructor({ id, projectId, entityType, name, normalizedName, properties = {}, createdAt = new Date(), updatedAt = new Date() }) {
    this.id = id;
    this.projectId = projectId;
    this.entityType = entityType;
    this.name = name;
    this.normalizedName = normalizedName;
    this.properties = properties;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  /**
   * Normalize an entity name for deduplication.
   * @param {string} name
   * @returns {string}
   */
  static normalizeName(name) {
    return name.toLowerCase().trim().replace(/\s+/g, '_');
  }

  /**
   * Factory: create a new KGEntity with generated ID.
   * @param {object} props
   * @param {string} props.projectId
   * @param {string} props.entityType
   * @param {string} props.name
   * @param {object} [props.properties]
   * @returns {KGEntity}
   */
  static create({ projectId, entityType, name, properties }) {
    if (!projectId) throw new Error('KGEntity requires projectId');
    if (!ENTITY_TYPES.includes(entityType)) {
      throw new Error(`Invalid entity type: ${entityType}. Valid: ${ENTITY_TYPES.join(', ')}`);
    }
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('KGEntity name must be a non-empty string');
    }
    return new KGEntity({
      id: randomUUID(),
      projectId,
      entityType,
      name: name.trim(),
      normalizedName: KGEntity.normalizeName(name),
      properties: properties || {},
    });
  }

  /**
   * Reconstitute from a database row.
   * @param {object} row
   * @returns {KGEntity}
   */
  static fromRow(row) {
    return new KGEntity({
      id: row.id,
      projectId: row.project_id,
      entityType: row.entity_type,
      name: row.name,
      normalizedName: row.normalized_name,
      properties: typeof row.properties === 'string' ? JSON.parse(row.properties) : (row.properties || {}),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    });
  }
}
