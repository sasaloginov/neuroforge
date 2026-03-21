const VALID_MODELS = ['opus', 'sonnet', 'haiku'];

export class Role {
  #name;
  #model;
  #timeoutMs;
  #allowedTools;
  #systemPrompt;

  constructor({ name, model, timeoutMs, allowedTools, systemPrompt }) {
    if (!name) throw new Error('Role name is required');
    if (!VALID_MODELS.includes(model)) throw new Error(`Invalid model: ${model}. Must be one of: ${VALID_MODELS.join(', ')}`);
    if (!timeoutMs || timeoutMs <= 0) throw new Error('timeoutMs must be positive');

    this.#name = name;
    this.#model = model;
    this.#timeoutMs = timeoutMs;
    this.#allowedTools = Object.freeze([...(allowedTools ?? [])]);
    this.#systemPrompt = systemPrompt ?? '';
  }

  get name() { return this.#name; }
  get model() { return this.#model; }
  get timeoutMs() { return this.#timeoutMs; }
  get allowedTools() { return this.#allowedTools; }
  get systemPrompt() { return this.#systemPrompt; }

  equals(other) {
    return other instanceof Role && this.#name === other.name;
  }
}
