/**
 * Port: Agent Memory Repository.
 * Persistence for shared agent memories with hybrid search.
 *
 * @interface IAgentMemoryRepo
 */
export class IAgentMemoryRepo {
  /**
   * Save a new agent memory.
   * @param {import('../entities/AgentMemory.js').AgentMemory} memory
   * @returns {Promise<void>}
   */
  async save(_memory) { throw new Error('Not implemented'); }

  /**
   * Hybrid search: vector similarity + full-text search + RRF.
   * @param {string} projectId - Project UUID
   * @param {Float32Array} embedding - Query embedding
   * @param {object} [options]
   * @param {number} [options.limit] - Max results
   * @param {string[]} [options.sections] - Filter by section(s)
   * @param {string} [options.queryText] - Original text for FTS
   * @param {number} [options.minScore] - Minimum composite score threshold
   * @returns {Promise<import('../entities/AgentMemory.js').AgentMemory[]>}
   */
  async search(_projectId, _embedding, _options) { throw new Error('Not implemented'); }

  /**
   * Record an access to a memory (bump counter + timestamp).
   * @param {string} id - Memory UUID
   * @returns {Promise<void>}
   */
  async updateAccess(_id) { throw new Error('Not implemented'); }

  /**
   * Find memories similar to the given embedding (for deduplication).
   * @param {string} projectId
   * @param {Float32Array} embedding
   * @param {number} threshold - Minimum cosine similarity (0-1)
   * @returns {Promise<import('../entities/AgentMemory.js').AgentMemory[]>}
   */
  async findSimilar(_projectId, _embedding, _threshold) { throw new Error('Not implemented'); }

  /**
   * Archive a memory (soft delete).
   * @param {string} id
   * @returns {Promise<void>}
   */
  async archive(_id) { throw new Error('Not implemented'); }

  /**
   * Find memories by IDs.
   * @param {string[]} ids - Memory UUIDs
   * @returns {Promise<import('../entities/AgentMemory.js').AgentMemory[]>}
   */
  async findByIds(_ids) { throw new Error('Not implemented'); }

  /**
   * Get decay candidates for archiving.
   * @param {string} projectId
   * @param {number} decayFactor
   * @param {number} archiveThreshold
   * @returns {Promise<import('../entities/AgentMemory.js').AgentMemory[]>}
   */
  async getDecayCandidates(_projectId, _decayFactor, _archiveThreshold) { throw new Error('Not implemented'); }
}
