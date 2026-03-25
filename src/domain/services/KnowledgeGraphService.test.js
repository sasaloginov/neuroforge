import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeGraphService } from './KnowledgeGraphService.js';

describe('KnowledgeGraphService', () => {
  let service;
  let mockRepo;
  let mockExtractor;
  let mockLogger;

  const projectId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    mockRepo = {
      upsertEntity: vi.fn().mockImplementation(entity => Promise.resolve({ ...entity, id: entity.id })),
      upsertRelation: vi.fn().mockImplementation(rel => Promise.resolve(rel)),
      findEntitiesByText: vi.fn().mockResolvedValue([]),
      findEntitiesByNormalizedName: vi.fn().mockResolvedValue([]),
      traverse: vi.fn().mockResolvedValue({ entities: [], relations: [], memoryIds: [] }),
      getEntityRelations: vi.fn().mockResolvedValue([]),
      getProjectGraph: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
    };

    mockExtractor = {
      extractEntities: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
    };

    mockLogger = { log: vi.fn(), warn: vi.fn() };

    service = new KnowledgeGraphService({
      knowledgeGraphRepo: mockRepo,
      kgEntityExtractor: mockExtractor,
      logger: mockLogger,
    });
  });

  describe('extractAndStore()', () => {
    it('extracts and upserts entities and relations', async () => {
      mockExtractor.extractEntities.mockResolvedValue({
        entities: [
          { name: 'TaskService', type: 'module', properties: {} },
          { name: 'PostgreSQL', type: 'technology', properties: {} },
        ],
        relations: [
          { source: 'TaskService', target: 'PostgreSQL', type: 'USES', confidence: 0.9, properties: {} },
        ],
      });

      // Mock upsertEntity to return entities with IDs
      let callIdx = 0;
      mockRepo.upsertEntity.mockImplementation(entity => {
        return Promise.resolve({ ...entity });
      });

      const result = await service.extractAndStore(projectId, 'TaskService uses PostgreSQL for persistence', ['mem-1']);

      expect(result.entitiesCount).toBe(2);
      expect(result.relationsCount).toBe(1);
      expect(mockRepo.upsertEntity).toHaveBeenCalledTimes(2);
      expect(mockRepo.upsertRelation).toHaveBeenCalledTimes(1);

      // Verify relation has memoryId
      const relCall = mockRepo.upsertRelation.mock.calls[0][0];
      expect(relCall.memoryId).toBe('mem-1');
    });

    it('returns zeros when no entities extracted', async () => {
      mockExtractor.extractEntities.mockResolvedValue({ entities: [], relations: [] });

      const result = await service.extractAndStore(projectId, 'some text');
      expect(result).toEqual({ entitiesCount: 0, relationsCount: 0 });
      expect(mockRepo.upsertEntity).not.toHaveBeenCalled();
    });

    it('skips relations with unknown entity names', async () => {
      mockExtractor.extractEntities.mockResolvedValue({
        entities: [{ name: 'TaskService', type: 'module', properties: {} }],
        relations: [
          { source: 'TaskService', target: 'UnknownEntity', type: 'USES', confidence: 0.9, properties: {} },
        ],
      });

      const result = await service.extractAndStore(projectId, 'text');
      expect(result.entitiesCount).toBe(1);
      expect(result.relationsCount).toBe(0);
      expect(mockRepo.upsertRelation).not.toHaveBeenCalled();
    });

    it('handles entities with no relations', async () => {
      mockExtractor.extractEntities.mockResolvedValue({
        entities: [
          { name: 'TaskService', type: 'module', properties: {} },
          { name: 'DDD', type: 'concept', properties: {} },
        ],
        relations: [],
      });

      const result = await service.extractAndStore(projectId, 'text');
      expect(result.entitiesCount).toBe(2);
      expect(result.relationsCount).toBe(0);
    });
  });

  describe('findRelatedMemories()', () => {
    it('returns empty when no matching entities found', async () => {
      mockRepo.findEntitiesByText.mockResolvedValue([]);

      const result = await service.findRelatedMemories(projectId, 'unknown query');
      expect(result).toEqual({ memoryIds: [], graphContext: '' });
    });

    it('returns empty for empty query', async () => {
      const result = await service.findRelatedMemories(projectId, '');
      expect(result).toEqual({ memoryIds: [], graphContext: '' });
    });

    it('traverses graph from seed entities and returns memoryIds', async () => {
      const seedEntities = [
        { id: 'e1', name: 'TaskService', entityType: 'module', projectId, normalizedName: 'taskservice', properties: {} },
      ];

      mockRepo.findEntitiesByText.mockResolvedValue(seedEntities);
      mockRepo.traverse.mockResolvedValue({
        entities: [
          ...seedEntities,
          { id: 'e2', name: 'PostgreSQL', entityType: 'technology', projectId, normalizedName: 'postgresql', properties: {} },
        ],
        relations: [
          { id: 'r1', sourceEntityId: 'e1', targetEntityId: 'e2', relationType: 'USES', confidence: 0.9, memoryId: 'mem-1', properties: {} },
        ],
        memoryIds: ['mem-1', 'mem-2'],
      });

      const result = await service.findRelatedMemories(projectId, 'TaskService');
      expect(result.memoryIds).toEqual(['mem-1', 'mem-2']);
      expect(result.graphContext).toContain('TaskService');
      expect(result.graphContext).toContain('USES');
      expect(result.graphContext).toContain('PostgreSQL');
    });

    it('respects limit parameter', async () => {
      const seedEntities = [{ id: 'e1', name: 'Test', entityType: 'module', projectId, normalizedName: 'test', properties: {} }];
      mockRepo.findEntitiesByText.mockResolvedValue(seedEntities);
      mockRepo.traverse.mockResolvedValue({
        entities: seedEntities,
        relations: [],
        memoryIds: ['m1', 'm2', 'm3', 'm4', 'm5'],
      });

      const result = await service.findRelatedMemories(projectId, 'Test', 2);
      expect(result.memoryIds).toHaveLength(2);
    });
  });
});
