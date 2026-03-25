# Task Context

## Затрагиваемые файлы

### Новые файлы (создать)
- `src/domain/valueObjects/KGEntity.js` — value object узла графа
- `src/domain/valueObjects/KGRelation.js` — value object связи графа
- `src/domain/ports/IKnowledgeGraphRepo.js` — порт репозитория графа
- `src/domain/ports/IKGEntityExtractor.js` — порт LLM-экстрактора сущностей
- `src/domain/services/KnowledgeGraphService.js` — сервис графа знаний
- `src/infrastructure/persistence/PgKnowledgeGraphRepo.js` — PostgreSQL реализация
- `src/infrastructure/claude/haikuKGEntityExtractor.js` — Claude Haiku экстрактор
- `src/infrastructure/persistence/migrations/YYYYMMDD_012_knowledge_graph.js` — миграция

### Существующие файлы (изменить)
- `src/domain/services/AgentMemoryService.js` — добавить KG в retrieve/store
- `src/index.js` — DI wiring новых сервисов (критичный файл оркестрации)

## Ключевые сигнатуры

### AgentMemoryService (`src/domain/services/AgentMemoryService.js`)
```javascript
constructor({memoryRepo, embeddingEngine, insightExtractor, logger})
async storeFromResponse(projectId, roleName, taskId, prompt, response) → number
async retrieve(projectId, queryText, {role, sections, limit=5}) → AgentMemory[]
formatForPrompt(memories) → string
```
Добавить `knowledgeGraphService` в constructor (optional).

### PgAgentMemoryRepo (`src/infrastructure/persistence/PgAgentMemoryRepo.js`)
```javascript
constructor(pool)
async search(projectId, embedding, {limit, sections, queryText, minScore}) → AgentMemory[]
async save(memory) → void
async findSimilar(projectId, embedding, threshold=0.90) → AgentMemory[]
```
RRF реализован внутри `search()` — 2 CTE (vector_ranked, text_ranked) + FULL OUTER JOIN.

### AgentInsightExtractor (`src/infrastructure/claude/agentInsightExtractor.js`)
```javascript
constructor(anthropicApiKey)
async extractInsights(roleName, prompt, response) → [{content, section, importance}]
```
Модель: `claude-haiku-4-5-20251001`, max_tokens: 1024. Используй как референс для HaikuKGEntityExtractor.

### OllamaEmbeddingAdapter (`src/infrastructure/embedding/OllamaEmbeddingAdapter.js`)
```javascript
constructor({baseUrl, model='bge-m3', dimensions=1024})
async embed(text) → Float32Array
async embedBatch(texts[]) → Float32Array[]
```

### ProcessRun (`src/application/ProcessRun.js`)
```javascript
constructor({chatEngine, runService, taskService, sessionRepo, gitOps, callbackSender, roleRegistry, agentMemoryService, logger})
```
Memory retrieval: строки 94-111. `agentMemoryService` инжектится через constructor.

## Зависимости

```
ProcessRun → AgentMemoryService → {IAgentMemoryRepo, IEmbeddingEngine, IInsightExtractor}
                                 + KnowledgeGraphService (NEW, optional)
KnowledgeGraphService → {IKnowledgeGraphRepo, IKGEntityExtractor}
PgKnowledgeGraphRepo → pg pool (тот же что PgAgentMemoryRepo)
HaikuKGEntityExtractor → Anthropic SDK (@anthropic-ai/sdk)
```

DI wiring: `src/index.js` (composition root, строки ~50-150).

## Текущее поведение

1. **Storage:** `storeFromResponse()` → extract insights (Haiku) → embed (Ollama) → dedup → save to `agent_memories`
2. **Retrieval:** `retrieve()` → embed query → `search()` с RRF (vector CTE + text CTE + FULL OUTER JOIN) → format XML `<project_memory>`
3. **RRF:** `composite = (1/(60+vec_rank) + 1/(60+txt_rank)) × recency × importance × access_boost`
4. **Integration:** `ProcessRun.execute()` calls `retrieve()` перед запуском агента, инжектит memories в prompt

Нужно добавить третий сигнал (graph_rank) в RRF и параллельный KG extraction при storage.
