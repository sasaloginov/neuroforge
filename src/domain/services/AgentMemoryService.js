import { AgentMemory } from '../entities/AgentMemory.js';

/**
 * Default sections each role should search in during retrieval.
 */
const ROLE_SECTIONS = {
  analyst:                ['architecture', 'evolution', 'decisions', 'conventions'],
  developer:              ['architecture', 'conventions', 'review_patterns', 'debug_insights', 'decisions'],
  'reviewer-architecture': ['architecture', 'conventions', 'review_patterns', 'decisions'],
  'reviewer-business':     ['conventions', 'review_patterns', 'decisions'],
  'reviewer-security':     ['review_patterns', 'architecture', 'debug_insights'],
  tester:                 ['test_strategies', 'conventions', 'debug_insights'],
  cto:                    ['architecture', 'evolution', 'decisions', 'integration_notes'],
};

/** Default max memories to return */
const DEFAULT_LIMIT = 5;

/** Minimum composite score to include in results */
const DEFAULT_MIN_SCORE = 0.3;

/** Similarity threshold for deduplication */
const DEDUP_THRESHOLD = 0.90;

/**
 * AgentMemoryService — orchestrates memory retrieval and storage for agents.
 * Depends only on domain ports (IAgentMemoryRepo, IEmbeddingEngine, IInsightExtractor).
 * Optionally integrates KnowledgeGraphService for graph-enhanced retrieval.
 */

/** Default graph weight in RRF fusion */
const GRAPH_RRF_WEIGHT = 0.7;

/** RRF smoothing constant */
const RRF_K = 60;

export class AgentMemoryService {
  #memoryRepo;
  #embeddingEngine;
  #insightExtractor;
  #knowledgeGraphService;
  #logger;

  /**
   * @param {object} deps
   * @param {import('../ports/IAgentMemoryRepo.js').IAgentMemoryRepo} deps.memoryRepo
   * @param {import('../ports/IEmbeddingEngine.js').IEmbeddingEngine} deps.embeddingEngine
   * @param {import('../ports/IInsightExtractor.js').IInsightExtractor} deps.insightExtractor
   * @param {import('./KnowledgeGraphService.js').KnowledgeGraphService} [deps.knowledgeGraphService]
   * @param {object} [deps.logger]
   */
  constructor({ memoryRepo, embeddingEngine, insightExtractor, knowledgeGraphService, logger }) {
    this.#memoryRepo = memoryRepo;
    this.#embeddingEngine = embeddingEngine;
    this.#insightExtractor = insightExtractor;
    this.#knowledgeGraphService = knowledgeGraphService || null;
    this.#logger = logger || console;
  }

  /**
   * Retrieve relevant memories for an agent run.
   * @param {string} projectId
   * @param {string} queryText - The run prompt or task description
   * @param {object} [options]
   * @param {string} [options.role] - Agent role name (for section filtering)
   * @param {number} [options.limit] - Max results (default 5)
   * @param {string[]} [options.sections] - Override section filter
   * @returns {Promise<AgentMemory[]>}
   */
  async retrieve(projectId, queryText, options = {}) {
    const { role, limit = DEFAULT_LIMIT, sections } = options;

    const embedding = await this.#embeddingEngine.embed(queryText);

    const searchSections = sections || (role && ROLE_SECTIONS[role]) || null;

    // Run vector+FTS search and graph search in parallel
    const graphPromise = this.#knowledgeGraphService
      ? this.#knowledgeGraphService.findRelatedMemories(projectId, queryText, limit)
          .catch(err => {
            this.#logger.warn('[AgentMemory] Graph search failed: %s', err.message);
            return { memoryIds: [], graphContext: '' };
          })
      : Promise.resolve({ memoryIds: [], graphContext: '' });

    const [memories, graphResult] = await Promise.all([
      this.#memoryRepo.search(projectId, embedding, {
        limit: limit * 2, // fetch more for RRF fusion
        sections: searchSections,
        queryText,
        minScore: DEFAULT_MIN_SCORE,
      }),
      graphPromise,
    ]);

    // Fuse graph results with vector+FTS results
    const fused = await this.#fuseWithGraphRRF(memories, graphResult.memoryIds, limit);

    // Update access counts (fire-and-forget)
    for (const mem of fused) {
      this.#memoryRepo.updateAccess(mem.id).catch(() => {});
    }

    // Attach graph context for prompt formatting
    if (graphResult.graphContext) {
      fused._graphContext = graphResult.graphContext;
    }

    return fused;
  }

  /**
   * Fuse vector+FTS results with graph-discovered memory IDs via RRF.
   * Memories found by both vector and graph get a score boost.
   * Graph-only memories (not in vector results) are fetched and included.
   * @param {AgentMemory[]} vectorResults - Results from hybrid vector+FTS search
   * @param {string[]} graphMemoryIds - Memory IDs discovered via graph traversal
   * @param {number} limit - Max results to return
   * @returns {Promise<AgentMemory[]>}
   */
  async #fuseWithGraphRRF(vectorResults, graphMemoryIds, limit) {
    if (!graphMemoryIds || graphMemoryIds.length === 0) {
      return vectorResults.slice(0, limit);
    }

    const graphIdSet = new Set(graphMemoryIds);
    const graphRankMap = new Map();
    graphMemoryIds.forEach((id, idx) => graphRankMap.set(id, idx + 1));

    // Boost scores for memories also found by graph search
    const boosted = vectorResults.map((mem, idx) => {
      const vectorRank = idx + 1;
      const baseScore = mem.compositeScore || (1 / (RRF_K + vectorRank));

      if (graphIdSet.has(mem.id)) {
        const graphRank = graphRankMap.get(mem.id);
        const graphBoost = GRAPH_RRF_WEIGHT * (1 / (RRF_K + graphRank));
        mem.compositeScore = baseScore + graphBoost;
        graphIdSet.delete(mem.id); // mark as accounted for
      } else {
        mem.compositeScore = baseScore;
      }

      return mem;
    });

    // Fetch graph-only memories (found by graph but not by vector search)
    const graphOnlyIds = [...graphIdSet];
    if (graphOnlyIds.length > 0) {
      const graphOnlyMemories = await this.#memoryRepo.findByIds(graphOnlyIds);
      for (const mem of graphOnlyMemories) {
        const graphRank = graphRankMap.get(mem.id);
        mem.compositeScore = GRAPH_RRF_WEIGHT * (1 / (RRF_K + graphRank));
        boosted.push(mem);
      }
    }

    // Re-sort by boosted score
    boosted.sort((a, b) => (b.compositeScore || 0) - (a.compositeScore || 0));

    return boosted.slice(0, limit);
  }

  /**
   * Store insights extracted from an agent's response.
   * Fire-and-forget: caller should .catch() errors.
   *
   * @param {string} projectId
   * @param {string} roleName
   * @param {string|null} taskId
   * @param {string} prompt - Run prompt
   * @param {string} response - Agent response
   * @returns {Promise<number>} - Number of insights stored
   */
  async storeFromResponse(projectId, roleName, taskId, prompt, response) {
    // 1. Extract insights via LLM
    const insights = await this.#insightExtractor.extractInsights(roleName, prompt, response);

    if (!insights || insights.length === 0) {
      this.#logger.log('[AgentMemory] No insights extracted from %s run', roleName);
      return 0;
    }

    // 2. Embed all insights in batch
    const texts = insights.map(i => i.content);
    const embeddings = await this.#embeddingEngine.embedBatch(texts);

    // 3. Dedup + save
    let stored = 0;
    const savedMemoryIds = [];
    for (let i = 0; i < insights.length; i++) {
      const insight = insights[i];
      const embedding = embeddings[i];

      // Check for duplicates
      const similar = await this.#memoryRepo.findSimilar(projectId, embedding, DEDUP_THRESHOLD);
      if (similar.length > 0) {
        this.#logger.log('[AgentMemory] Skipping duplicate insight: "%s"', insight.content.slice(0, 60));
        continue;
      }

      const memory = AgentMemory.create({
        projectId,
        taskId,
        role: roleName,
        section: insight.section,
        content: insight.content,
        embedding,
        importance: insight.importance,
        metadata: { shortId: insight.shortId || null },
      });

      await this.#memoryRepo.save(memory);
      savedMemoryIds.push(memory.id);
      stored++;
    }

    this.#logger.log('[AgentMemory] Stored %d/%d insights from %s run', stored, insights.length, roleName);

    // Extract and store KG entities/relations (fire-and-forget, non-blocking)
    if (this.#knowledgeGraphService && stored > 0) {
      this.#knowledgeGraphService.extractAndStore(projectId, response, savedMemoryIds)
        .catch(err => this.#logger.warn('[AgentMemory] KG extraction failed: %s', err.message));
    }

    return stored;
  }

  /**
   * Format memories into XML for prompt injection.
   * @param {AgentMemory[]} memories
   * @returns {string}
   */
  formatForPrompt(memories) {
    if (!memories || memories.length === 0) return '';

    const lines = memories.map(m => {
      const attrs = [
        `section="${m.section}"`,
        `importance="${m.importance.toFixed(1)}"`,
        `age="${m.age}"`,
      ];
      if (m.role) attrs.push(`source="${m.role}"`);
      return `<memory ${attrs.join(' ')}>\n${m.content}\n</memory>`;
    });

    let result = lines.join('\n');

    // Append graph context if available
    if (memories._graphContext) {
      result += `\n\n<knowledge_graph>\n${memories._graphContext}\n</knowledge_graph>`;
    }

    return result;
  }
}
