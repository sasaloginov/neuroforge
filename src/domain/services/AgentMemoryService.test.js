import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentMemoryService } from './AgentMemoryService.js';
import { AgentMemory } from '../entities/AgentMemory.js';

describe('AgentMemoryService', () => {
  let service;
  let mockMemoryRepo;
  let mockEmbeddingEngine;
  let mockInsightExtractor;
  let mockKnowledgeGraphService;
  let mockLogger;

  const projectId = '550e8400-e29b-41d4-a716-446655440000';
  const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3]);

  function makeMemory(id, opts = {}) {
    return new AgentMemory({
      id,
      projectId,
      role: 'developer',
      section: 'architecture',
      content: `Memory content for ${id}`,
      embedding: fakeEmbedding,
      importance: opts.importance ?? 0.8,
      compositeScore: opts.compositeScore ?? null,
      createdAt: new Date(),
      lastAccessed: new Date(),
    });
  }

  beforeEach(() => {
    mockMemoryRepo = {
      search: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue(undefined),
      updateAccess: vi.fn().mockResolvedValue(undefined),
      findSimilar: vi.fn().mockResolvedValue([]),
      findByIds: vi.fn().mockResolvedValue([]),
    };

    mockEmbeddingEngine = {
      embed: vi.fn().mockResolvedValue(fakeEmbedding),
      embedBatch: vi.fn().mockResolvedValue([fakeEmbedding]),
    };

    mockInsightExtractor = {
      extractInsights: vi.fn().mockResolvedValue([]),
    };

    mockKnowledgeGraphService = {
      findRelatedMemories: vi.fn().mockResolvedValue({ memoryIds: [], graphContext: '' }),
      extractAndStore: vi.fn().mockResolvedValue({ entitiesCount: 0, relationsCount: 0 }),
    };

    mockLogger = { log: vi.fn(), warn: vi.fn() };
  });

  function createService(withKG = true) {
    return new AgentMemoryService({
      memoryRepo: mockMemoryRepo,
      embeddingEngine: mockEmbeddingEngine,
      insightExtractor: mockInsightExtractor,
      knowledgeGraphService: withKG ? mockKnowledgeGraphService : undefined,
      logger: mockLogger,
    });
  }

  describe('retrieve()', () => {
    it('works without KnowledgeGraphService (backward compatible)', async () => {
      service = createService(false);
      const mem1 = makeMemory('m1', { compositeScore: 0.5 });
      mockMemoryRepo.search.mockResolvedValue([mem1]);

      const result = await service.retrieve(projectId, 'test query');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('m1');
      expect(mockMemoryRepo.search).toHaveBeenCalled();
    });

    it('boosts vector results that also appear in graph results', async () => {
      service = createService(true);
      const mem1 = makeMemory('m1', { compositeScore: 0.5 });
      const mem2 = makeMemory('m2', { compositeScore: 0.4 });
      mockMemoryRepo.search.mockResolvedValue([mem1, mem2]);
      mockKnowledgeGraphService.findRelatedMemories.mockResolvedValue({
        memoryIds: ['m2'],
        graphContext: '',
      });

      const result = await service.retrieve(projectId, 'test query');
      const m1result = result.find(m => m.id === 'm1');
      const m2result = result.find(m => m.id === 'm2');
      expect(m2result).toBeDefined();
      // m2 (rank 2) with graph boost should have higher score than without boost
      // baseScore for m2 at rank 2 = 1/(60+2) = 0.01613
      // graphBoost for m2 at graph rank 1 = 0.7 * 1/(60+1) = 0.01148
      // m2 boosted = 0.01613 + 0.01148 = 0.02760
      // m1 at rank 1 = 1/(60+1) = 0.01639 (no boost)
      // So m2 boosted > m1 unboosted
      expect(m2result.compositeScore).toBeGreaterThan(m1result.compositeScore);
    });

    it('includes graph-only memories not found by vector search', async () => {
      service = createService(true);
      const mem1 = makeMemory('m1', { compositeScore: 0.5 });
      mockMemoryRepo.search.mockResolvedValue([mem1]);

      const graphOnlyMem = makeMemory('m-graph-only');
      mockKnowledgeGraphService.findRelatedMemories.mockResolvedValue({
        memoryIds: ['m-graph-only'],
        graphContext: '',
      });
      mockMemoryRepo.findByIds.mockResolvedValue([graphOnlyMem]);

      const result = await service.retrieve(projectId, 'test query');
      const ids = result.map(m => m.id);
      expect(ids).toContain('m-graph-only');
      expect(mockMemoryRepo.findByIds).toHaveBeenCalledWith(['m-graph-only']);
    });

    it('handles graph search failure gracefully (fallback to vector only)', async () => {
      service = createService(true);
      const mem1 = makeMemory('m1', { compositeScore: 0.5 });
      mockMemoryRepo.search.mockResolvedValue([mem1]);
      mockKnowledgeGraphService.findRelatedMemories.mockRejectedValue(
        new Error('Graph DB connection failed')
      );

      const result = await service.retrieve(projectId, 'test query');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('m1');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('respects limit parameter', async () => {
      service = createService(true);
      const memories = Array.from({ length: 10 }, (_, i) =>
        makeMemory(`m${i}`, { compositeScore: 1 - i * 0.1 })
      );
      mockMemoryRepo.search.mockResolvedValue(memories);

      const result = await service.retrieve(projectId, 'test', { limit: 3 });
      expect(result).toHaveLength(3);
    });

    it('attaches graphContext to results', async () => {
      service = createService(true);
      const mem1 = makeMemory('m1', { compositeScore: 0.5 });
      mockMemoryRepo.search.mockResolvedValue([mem1]);
      mockKnowledgeGraphService.findRelatedMemories.mockResolvedValue({
        memoryIds: [],
        graphContext: '<entity name="TaskService" type="module"/>',
      });

      const result = await service.retrieve(projectId, 'test query');
      expect(result._graphContext).toContain('TaskService');
    });
  });

  describe('storeFromResponse()', () => {
    it('calls KG extractAndStore after storing memories', async () => {
      service = createService(true);
      mockInsightExtractor.extractInsights.mockResolvedValue([
        { content: 'DDD architecture with clean layers', section: 'architecture', importance: 0.8 },
      ]);
      mockMemoryRepo.findSimilar.mockResolvedValue([]);

      const stored = await service.storeFromResponse(projectId, 'developer', null, 'prompt', 'response text');
      expect(stored).toBe(1);

      // Wait for fire-and-forget KG extraction
      await vi.waitFor(() => {
        expect(mockKnowledgeGraphService.extractAndStore).toHaveBeenCalledWith(
          projectId,
          'response text',
          expect.arrayContaining([expect.any(String)]),
        );
      });
    });

    it('does not block on KG extraction failure', async () => {
      service = createService(true);
      mockInsightExtractor.extractInsights.mockResolvedValue([
        { content: 'Some insight about the system architecture', section: 'architecture', importance: 0.7 },
      ]);
      mockMemoryRepo.findSimilar.mockResolvedValue([]);
      mockKnowledgeGraphService.extractAndStore.mockRejectedValue(new Error('KG failed'));

      const stored = await service.storeFromResponse(projectId, 'developer', null, 'prompt', 'response');
      expect(stored).toBe(1);
      // Should not throw
    });

    it('does not call KG extraction when no insights stored', async () => {
      service = createService(true);
      mockInsightExtractor.extractInsights.mockResolvedValue([]);

      await service.storeFromResponse(projectId, 'developer', null, 'prompt', 'response');
      expect(mockKnowledgeGraphService.extractAndStore).not.toHaveBeenCalled();
    });

    it('works without KnowledgeGraphService', async () => {
      service = createService(false);
      mockInsightExtractor.extractInsights.mockResolvedValue([
        { content: 'Clean architecture insight for testing', section: 'conventions', importance: 0.7 },
      ]);
      mockMemoryRepo.findSimilar.mockResolvedValue([]);

      const stored = await service.storeFromResponse(projectId, 'developer', null, 'prompt', 'response');
      expect(stored).toBe(1);
    });
  });

  describe('formatForPrompt()', () => {
    it('returns empty string for empty memories', () => {
      service = createService(false);
      expect(service.formatForPrompt([])).toBe('');
      expect(service.formatForPrompt(null)).toBe('');
    });

    it('formats memories as XML', () => {
      service = createService(false);
      const mem = makeMemory('m1');
      const result = service.formatForPrompt([mem]);
      expect(result).toContain('<memory');
      expect(result).toContain('section="architecture"');
      expect(result).toContain('Memory content for m1');
      expect(result).toContain('</memory>');
    });

    it('appends knowledge_graph block when graphContext is attached', () => {
      service = createService(false);
      const mem = makeMemory('m1');
      const memories = [mem];
      memories._graphContext = '<entity name="TaskService" type="module"/>';

      const result = service.formatForPrompt(memories);
      expect(result).toContain('<knowledge_graph>');
      expect(result).toContain('TaskService');
      expect(result).toContain('</knowledge_graph>');
    });
  });

  describe('#fuseWithGraphRRF (through retrieve)', () => {
    it('returns vector results sliced to limit when no graph results', async () => {
      service = createService(true);
      const memories = [
        makeMemory('m1', { compositeScore: 0.9 }),
        makeMemory('m2', { compositeScore: 0.8 }),
        makeMemory('m3', { compositeScore: 0.7 }),
      ];
      mockMemoryRepo.search.mockResolvedValue(memories);
      mockKnowledgeGraphService.findRelatedMemories.mockResolvedValue({
        memoryIds: [],
        graphContext: '',
      });

      const result = await service.retrieve(projectId, 'query', { limit: 2 });
      expect(result).toHaveLength(2);
    });

    it('graph-only memories get graph-rank-based score', async () => {
      service = createService(true);
      mockMemoryRepo.search.mockResolvedValue([]);

      const graphMem = makeMemory('m-graph');
      mockKnowledgeGraphService.findRelatedMemories.mockResolvedValue({
        memoryIds: ['m-graph'],
        graphContext: '',
      });
      mockMemoryRepo.findByIds.mockResolvedValue([graphMem]);

      const result = await service.retrieve(projectId, 'query');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('m-graph');
      // Score = 0.7 * 1/(60+1) ≈ 0.01148
      expect(result[0].compositeScore).toBeCloseTo(0.7 * (1 / 61), 5);
    });

    it('does not duplicate memories found by both vector and graph', async () => {
      service = createService(true);
      const mem1 = makeMemory('m1', { compositeScore: 0.5 });
      mockMemoryRepo.search.mockResolvedValue([mem1]);
      mockKnowledgeGraphService.findRelatedMemories.mockResolvedValue({
        memoryIds: ['m1'],
        graphContext: '',
      });

      const result = await service.retrieve(projectId, 'query');
      const m1count = result.filter(m => m.id === 'm1').length;
      expect(m1count).toBe(1);
      // findByIds should NOT be called since m1 was already in vector results
      expect(mockMemoryRepo.findByIds).not.toHaveBeenCalled();
    });
  });
});
