/**
 * Port: Knowledge Graph Entity Extractor.
 * Extracts entities and relations from text for graph construction.
 *
 * @interface IKGEntityExtractor
 */
export class IKGEntityExtractor {
  /**
   * Extract entities and relations from text.
   * @param {string} text - Source text to extract from
   * @returns {Promise<{entities: Array<{name: string, type: string, properties: object}>, relations: Array<{source: string, target: string, type: string, confidence: number, properties: object}>}>}
   */
  async extractEntities(_text) { throw new Error('Not implemented'); }
}
