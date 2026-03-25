import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HaikuKGEntityExtractor } from './haikuKGEntityExtractor.js';

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: class MockAnthropic {
      constructor() {
        this.messages = { create: mockCreate };
      }
    },
    __mockCreate: mockCreate,
  };
});

function getMockCreate() {
  // Access the mock through a fresh import to get the shared mock fn
  const mod = vi.mocked(require('@anthropic-ai/sdk'));
  // We need the static reference — use the extractor's internal client
  return null; // We'll use a different approach
}

describe('HaikuKGEntityExtractor', () => {
  let extractor;
  let mockCreate;
  let mockLogger;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLogger = { log: vi.fn(), warn: vi.fn() };

    // Get the mock create function
    const sdk = await import('@anthropic-ai/sdk');
    extractor = new HaikuKGEntityExtractor({ logger: mockLogger });
    // Access the mock through the module's exported mock
    mockCreate = sdk.__mockCreate;
  });

  function mockLLMResponse(text) {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text }],
    });
  }

  describe('extractEntities()', () => {
    it('returns empty for short text (<50 chars)', async () => {
      const result = await extractor.extractEntities('short');
      expect(result).toEqual({ entities: [], relations: [] });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('parses valid JSON response with entities and relations', async () => {
      mockLLMResponse(JSON.stringify({
        entities: [
          { name: 'TaskService', type: 'module', properties: { layer: 'domain' } },
          { name: 'PostgreSQL', type: 'technology', properties: {} },
        ],
        relations: [
          { source: 'TaskService', target: 'PostgreSQL', type: 'USES', confidence: 0.9, properties: {} },
        ],
      }));

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result.entities).toHaveLength(2);
      expect(result.entities[0].name).toBe('TaskService');
      expect(result.entities[0].type).toBe('module');
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].type).toBe('USES');
      expect(result.relations[0].confidence).toBe(0.9);
    });

    it('parses JSON wrapped in markdown code block', async () => {
      const json = JSON.stringify({
        entities: [{ name: 'Fastify', type: 'technology', properties: {} }],
        relations: [],
      });
      mockLLMResponse('```json\n' + json + '\n```');

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Fastify');
    });

    it('returns empty for completely invalid response', async () => {
      mockLLMResponse('This is not JSON at all, just text without braces');

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result).toEqual({ entities: [], relations: [] });
    });

    it('falls back to concept for invalid entity types', async () => {
      mockLLMResponse(JSON.stringify({
        entities: [
          { name: 'SomeEntity', type: 'INVALID_TYPE', properties: {} },
        ],
        relations: [],
      }));

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].type).toBe('concept');
    });

    it('filters self-referencing relations (source === target)', async () => {
      mockLLMResponse(JSON.stringify({
        entities: [
          { name: 'TaskService', type: 'module', properties: {} },
        ],
        relations: [
          { source: 'TaskService', target: 'TaskService', type: 'USES', confidence: 0.9, properties: {} },
        ],
      }));

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result.entities).toHaveLength(1);
      expect(result.relations).toHaveLength(0);
    });

    it('filters relations referencing unknown entities', async () => {
      mockLLMResponse(JSON.stringify({
        entities: [
          { name: 'TaskService', type: 'module', properties: {} },
        ],
        relations: [
          { source: 'TaskService', target: 'UnknownModule', type: 'DEPENDS_ON', confidence: 0.8, properties: {} },
        ],
      }));

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result.relations).toHaveLength(0);
    });

    it('truncates entities to max 15', async () => {
      const entities = Array.from({ length: 20 }, (_, i) => ({
        name: `Entity${i}`,
        type: 'module',
        properties: {},
      }));
      mockLLMResponse(JSON.stringify({ entities, relations: [] }));

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result.entities).toHaveLength(15);
    });

    it('truncates relations to max 20', async () => {
      const entities = [
        { name: 'ModuleAlpha', type: 'module', properties: {} },
        { name: 'ModuleBeta', type: 'module', properties: {} },
      ];
      const relations = Array.from({ length: 25 }, () => ({
        source: 'ModuleAlpha', target: 'ModuleBeta', type: 'USES', confidence: 0.8, properties: {},
      }));
      mockLLMResponse(JSON.stringify({ entities, relations }));

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result.relations.length).toBeLessThanOrEqual(20);
    });

    it('returns empty on API error (graceful degradation)', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API timeout'));

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result).toEqual({ entities: [], relations: [] });
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('falls back to RELATES_TO for invalid relation types', async () => {
      mockLLMResponse(JSON.stringify({
        entities: [
          { name: 'ModuleA', type: 'module', properties: {} },
          { name: 'ModuleB', type: 'module', properties: {} },
        ],
        relations: [
          { source: 'ModuleA', target: 'ModuleB', type: 'INVALID_REL', confidence: 0.8, properties: {} },
        ],
      }));

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result.relations[0].type).toBe('RELATES_TO');
    });

    it('clamps confidence to [0, 1]', async () => {
      mockLLMResponse(JSON.stringify({
        entities: [
          { name: 'ModuleA', type: 'module', properties: {} },
          { name: 'ModuleB', type: 'module', properties: {} },
        ],
        relations: [
          { source: 'ModuleA', target: 'ModuleB', type: 'USES', confidence: 5.0, properties: {} },
        ],
      }));

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result.relations[0].confidence).toBe(1);
    });

    it('filters entities with names shorter than 2 chars', async () => {
      mockLLMResponse(JSON.stringify({
        entities: [
          { name: 'X', type: 'module', properties: {} },
          { name: 'ValidName', type: 'module', properties: {} },
        ],
        relations: [],
      }));

      const result = await extractor.extractEntities('A'.repeat(60));
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('ValidName');
    });
  });
});
