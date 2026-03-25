/**
 * HaikuKGEntityExtractor — implements IKGEntityExtractor.
 * Uses Anthropic Haiku to extract entities and relations for Knowledge Graph.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ENTITY_TYPES } from '../../domain/valueObjects/KGEntity.js';
import { RELATION_TYPES } from '../../domain/valueObjects/KGRelation.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 30_000;

const EXTRACTION_PROMPT = `Extract entities and relations for a Knowledge Graph from the following text.

Entity types: ${ENTITY_TYPES.join(', ')}
Relation types: ${RELATION_TYPES.join(', ')}

Rules:
1. Extract ONLY concrete, named entities (specific module names, technologies, decisions, patterns).
2. Do NOT extract generic terms ("the system", "the code", "database").
3. Use the most specific and complete name for each entity.
4. Each relation must connect two extracted entities by name.
5. Confidence: 0.9-1.0 for explicitly stated facts, 0.6-0.8 for inferred relations.
6. Maximum 15 entities and 20 relations.
7. If nothing meaningful can be extracted, return empty arrays.

Respond ONLY with valid JSON:

{"entities":[{"name":"EntityName","type":"module","properties":{}}],"relations":[{"source":"SourceName","target":"TargetName","type":"USES","confidence":0.9,"properties":{}}]}

Text to analyze:

<text>{{TEXT}}</text>`;

export class HaikuKGEntityExtractor {
  #client;
  #logger;

  /**
   * @param {object} [deps]
   * @param {object} [deps.logger]
   */
  constructor(deps = {}) {
    this.#client = new Anthropic();
    this.#logger = deps.logger || console;
  }

  /**
   * Extract entities and relations from text.
   * @param {string} text
   * @returns {Promise<{entities: Array<{name: string, type: string, properties: object}>, relations: Array<{source: string, target: string, type: string, confidence: number, properties: object}>}>}
   */
  async extractEntities(text) {
    if (!text || text.length < 50) return { entities: [], relations: [] };

    const prompt = EXTRACTION_PROMPT.replace('{{TEXT}}', this.#truncate(text, 6000));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const result = await this.#client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }, { signal: controller.signal });

      const responseText = result.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      return this.#parseResponse(responseText);
    } catch (err) {
      this.#logger.warn('[KGExtractor] Extraction failed: %s', err.message);
      return { entities: [], relations: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse and validate the LLM response.
   * @param {string} text
   * @returns {{entities: Array, relations: Array}}
   */
  #parseResponse(text) {
    if (!text?.trim()) return { entities: [], relations: [] };

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return { entities: [], relations: [] };
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        this.#logger.warn('[KGExtractor] Could not parse response');
        return { entities: [], relations: [] };
      }
    }

    const entities = this.#validateEntities(parsed.entities);
    const relations = this.#validateRelations(parsed.relations, entities);

    return { entities, relations };
  }

  /**
   * Validate and clean entities.
   * @param {Array} raw
   * @returns {Array<{name: string, type: string, properties: object}>}
   */
  #validateEntities(raw) {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter(e => e && typeof e === 'object' && typeof e.name === 'string' && e.name.trim().length >= 2)
      .slice(0, 15)
      .map(e => ({
        name: e.name.trim().slice(0, 200),
        type: ENTITY_TYPES.includes(e.type) ? e.type : 'concept',
        properties: (typeof e.properties === 'object' && e.properties !== null) ? e.properties : {},
      }));
  }

  /**
   * Validate and clean relations.
   * @param {Array} raw
   * @param {Array<{name: string}>} validEntities
   * @returns {Array<{source: string, target: string, type: string, confidence: number, properties: object}>}
   */
  #validateRelations(raw, validEntities) {
    if (!Array.isArray(raw)) return [];

    const entityNames = new Set(validEntities.map(e => e.name.toLowerCase()));

    return raw
      .filter(r => {
        if (!r || typeof r !== 'object') return false;
        if (!r.source || !r.target || r.source === r.target) return false;
        // Both endpoints must reference valid entities
        return entityNames.has(String(r.source).toLowerCase()) && entityNames.has(String(r.target).toLowerCase());
      })
      .slice(0, 20)
      .map(r => ({
        source: String(r.source).trim(),
        target: String(r.target).trim(),
        type: RELATION_TYPES.includes(r.type) ? r.type : 'RELATES_TO',
        confidence: typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0.8,
        properties: (typeof r.properties === 'object' && r.properties !== null) ? r.properties : {},
      }));
  }

  #truncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text || '';
    return text.slice(0, maxLen) + '...(truncated)';
  }
}
