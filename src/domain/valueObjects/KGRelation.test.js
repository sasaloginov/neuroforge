import { describe, it, expect } from 'vitest';
import { KGRelation, RELATION_TYPES } from './KGRelation.js';

describe('KGRelation', () => {
  const validProps = {
    projectId: '550e8400-e29b-41d4-a716-446655440000',
    sourceEntityId: '550e8400-e29b-41d4-a716-446655440001',
    targetEntityId: '550e8400-e29b-41d4-a716-446655440002',
    relationType: 'USES',
  };

  describe('create()', () => {
    it('creates relation with generated ID and defaults', () => {
      const rel = KGRelation.create(validProps);

      expect(rel.id).toBeDefined();
      expect(rel.projectId).toBe(validProps.projectId);
      expect(rel.sourceEntityId).toBe(validProps.sourceEntityId);
      expect(rel.targetEntityId).toBe(validProps.targetEntityId);
      expect(rel.relationType).toBe('USES');
      expect(rel.confidence).toBe(0.8);
      expect(rel.memoryId).toBeNull();
      expect(rel.properties).toEqual({});
    });

    it('accepts custom confidence and memoryId', () => {
      const rel = KGRelation.create({
        ...validProps,
        confidence: 0.95,
        memoryId: 'mem-123',
      });
      expect(rel.confidence).toBe(0.95);
      expect(rel.memoryId).toBe('mem-123');
    });

    it('clamps confidence to [0, 1]', () => {
      expect(KGRelation.create({ ...validProps, confidence: 1.5 }).confidence).toBe(1);
      expect(KGRelation.create({ ...validProps, confidence: -0.5 }).confidence).toBe(0);
    });

    it('throws on invalid relation type', () => {
      expect(() => KGRelation.create({ ...validProps, relationType: 'INVALID' }))
        .toThrow('Invalid relation type');
    });

    it('throws on missing sourceEntityId', () => {
      expect(() => KGRelation.create({ ...validProps, sourceEntityId: '' }))
        .toThrow('requires sourceEntityId');
    });

    it('throws on missing projectId', () => {
      expect(() => KGRelation.create({ ...validProps, projectId: '' }))
        .toThrow('requires projectId');
    });
  });

  describe('fromRow()', () => {
    it('reconstitutes from database row', () => {
      const row = {
        id: 'rel-id',
        project_id: validProps.projectId,
        source_entity_id: validProps.sourceEntityId,
        target_entity_id: validProps.targetEntityId,
        relation_type: 'DEPENDS_ON',
        confidence: '0.9',
        memory_id: 'mem-456',
        properties: {},
        created_at: new Date('2025-01-01'),
      };

      const rel = KGRelation.fromRow(row);
      expect(rel.relationType).toBe('DEPENDS_ON');
      expect(rel.confidence).toBe(0.9);
      expect(rel.memoryId).toBe('mem-456');
    });
  });

  describe('RELATION_TYPES', () => {
    it('contains all 7 types', () => {
      expect(RELATION_TYPES).toHaveLength(7);
      expect(RELATION_TYPES).toContain('USES');
      expect(RELATION_TYPES).toContain('DEPENDS_ON');
      expect(RELATION_TYPES).toContain('IMPLEMENTS');
      expect(RELATION_TYPES).toContain('DECIDED');
      expect(RELATION_TYPES).toContain('CAUSED_BY');
      expect(RELATION_TYPES).toContain('RESOLVED_BY');
      expect(RELATION_TYPES).toContain('RELATES_TO');
    });
  });
});
