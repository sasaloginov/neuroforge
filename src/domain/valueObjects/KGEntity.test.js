import { describe, it, expect } from 'vitest';
import { KGEntity, ENTITY_TYPES } from './KGEntity.js';

describe('KGEntity', () => {
  const validProps = {
    projectId: '550e8400-e29b-41d4-a716-446655440000',
    entityType: 'module',
    name: 'TaskService',
  };

  describe('create()', () => {
    it('creates entity with generated ID and normalized name', () => {
      const entity = KGEntity.create(validProps);

      expect(entity.id).toBeDefined();
      expect(entity.projectId).toBe(validProps.projectId);
      expect(entity.entityType).toBe('module');
      expect(entity.name).toBe('TaskService');
      expect(entity.normalizedName).toBe('taskservice');
      expect(entity.properties).toEqual({});
      expect(entity.createdAt).toBeInstanceOf(Date);
      expect(entity.updatedAt).toBeInstanceOf(Date);
    });

    it('normalizes name with spaces and mixed case', () => {
      const entity = KGEntity.create({ ...validProps, name: '  Task Service  ' });
      expect(entity.name).toBe('Task Service');
      expect(entity.normalizedName).toBe('task_service');
    });

    it('stores properties', () => {
      const entity = KGEntity.create({ ...validProps, properties: { layer: 'domain' } });
      expect(entity.properties).toEqual({ layer: 'domain' });
    });

    it('throws on invalid entity type', () => {
      expect(() => KGEntity.create({ ...validProps, entityType: 'invalid' }))
        .toThrow('Invalid entity type');
    });

    it('throws on empty name', () => {
      expect(() => KGEntity.create({ ...validProps, name: '' }))
        .toThrow('non-empty string');
    });

    it('throws on missing projectId', () => {
      expect(() => KGEntity.create({ entityType: 'module', name: 'Test' }))
        .toThrow('requires projectId');
    });
  });

  describe('normalizeName()', () => {
    it('lowercases and trims', () => {
      expect(KGEntity.normalizeName('  TaskService  ')).toBe('taskservice');
    });

    it('replaces spaces with underscores', () => {
      expect(KGEntity.normalizeName('Task Service')).toBe('task_service');
    });

    it('collapses multiple spaces', () => {
      expect(KGEntity.normalizeName('Task   Service   V2')).toBe('task_service_v2');
    });
  });

  describe('fromRow()', () => {
    it('reconstitutes from database row', () => {
      const row = {
        id: '550e8400-e29b-41d4-a716-446655440001',
        project_id: validProps.projectId,
        entity_type: 'technology',
        name: 'PostgreSQL',
        normalized_name: 'postgresql',
        properties: { version: '16' },
        created_at: new Date('2025-01-01'),
        updated_at: new Date('2025-01-02'),
      };

      const entity = KGEntity.fromRow(row);
      expect(entity.id).toBe(row.id);
      expect(entity.projectId).toBe(row.project_id);
      expect(entity.entityType).toBe('technology');
      expect(entity.name).toBe('PostgreSQL');
      expect(entity.properties).toEqual({ version: '16' });
    });

    it('parses JSON string properties', () => {
      const row = {
        id: 'test-id',
        project_id: 'proj-id',
        entity_type: 'module',
        name: 'Test',
        normalized_name: 'test',
        properties: '{"key":"value"}',
        created_at: '2025-01-01',
        updated_at: '2025-01-01',
      };

      const entity = KGEntity.fromRow(row);
      expect(entity.properties).toEqual({ key: 'value' });
    });
  });

  describe('ENTITY_TYPES', () => {
    it('contains all 7 types', () => {
      expect(ENTITY_TYPES).toHaveLength(7);
      expect(ENTITY_TYPES).toContain('module');
      expect(ENTITY_TYPES).toContain('concept');
      expect(ENTITY_TYPES).toContain('decision');
      expect(ENTITY_TYPES).toContain('technology');
      expect(ENTITY_TYPES).toContain('pattern');
      expect(ENTITY_TYPES).toContain('problem');
      expect(ENTITY_TYPES).toContain('person');
    });
  });
});
