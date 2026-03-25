# Task Context

## Затрагиваемые файлы

### Изменить
- `src/domain/services/AgentMemoryService.js` — fix `#fuseWithGraphRRF`: сделать async, добавить fetch graph-only memories через `this.#memoryRepo.findByIds()`
- `src/domain/ports/IAgentMemoryRepo.js` — добавить `async findByIds(ids) → AgentMemory[]`
- `src/infrastructure/persistence/PgAgentMemoryRepo.js` — реализовать `findByIds(ids)`

### Создать (тесты)
- `src/infrastructure/claude/haikuKGEntityExtractor.test.js` — unit-тесты парсинга/валидации
- `src/domain/services/AgentMemoryService.test.js` — unit-тесты retrieve/store с KG
- `src/infrastructure/persistence/PgKnowledgeGraphRepo.test.js` — integration-тесты (skip без DB)

## Ключевые сигнатуры

### AgentMemoryService (`src/domain/services/AgentMemoryService.js`)
```javascript
constructor({ memoryRepo, embeddingEngine, insightExtractor, knowledgeGraphService, logger })
async retrieve(projectId, queryText, { role, limit=5, sections }) → AgentMemory[]
async storeFromResponse(projectId, roleName, taskId, prompt, response) → number
formatForPrompt(memories) → string
// Private — нужно изменить:
#fuseWithGraphRRF(vectorResults, graphMemoryIds, limit) → AgentMemory[]  // сейчас sync
// Целевое:
async #fuseWithGraphRRF(vectorResults, graphMemoryIds, limit) → AgentMemory[]
```
Строка 120: `#fuseWithGraphRRF` — текущая реализация только бустит vector results.
Строка 97: вызов в `retrieve()` — добавить `await`.

### IAgentMemoryRepo (`src/domain/ports/IAgentMemoryRepo.js`)
```javascript
async save(memory) → void
async search(projectId, embedding, options) → AgentMemory[]
async updateAccess(id) → void
async findSimilar(projectId, embedding, threshold) → AgentMemory[]
// Добавить:
async findByIds(ids: string[]) → AgentMemory[]
```

### PgAgentMemoryRepo (`src/infrastructure/persistence/PgAgentMemoryRepo.js`)
```javascript
// Добавить после findSimilar (строка ~225):
async findByIds(ids) {
  // SELECT * FROM agent_memories WHERE id = ANY($1)
}
```

### HaikuKGEntityExtractor (`src/infrastructure/claude/haikuKGEntityExtractor.js`)
```javascript
constructor({ logger })
async extractEntities(text) → { entities[], relations[] }
// Private (тестировать через публичный API):
#parseResponse(text) → { entities[], relations[] }
#validateEntities(raw) → entities[]
#validateRelations(raw, validEntities) → relations[]
```
Модель: `claude-haiku-4-5-20251001`, MAX_TOKENS: 1024, TIMEOUT: 30s.
Лимиты: 15 entities, 20 relations. Fallback type: `'concept'` для entities, `'RELATES_TO'` для relations.

### KGEntity (`src/domain/valueObjects/KGEntity.js`)
```javascript
static ENTITY_TYPES = ['module','concept','decision','technology','pattern','problem','person']
static normalizeName(name) → string  // toLowerCase + trim + replace spaces→underscores
static create({ projectId, entityType, name, properties }) → KGEntity
static fromRow(row) → KGEntity
```

### KGRelation (`src/domain/valueObjects/KGRelation.js`)
```javascript
static RELATION_TYPES = ['USES','DEPENDS_ON','IMPLEMENTS','DECIDED','CAUSED_BY','RESOLVED_BY','RELATES_TO']
static create({ projectId, sourceEntityId, targetEntityId, relationType, confidence, memoryId, properties }) → KGRelation
static fromRow(row) → KGRelation
```

### AgentMemory (`src/domain/entities/AgentMemory.js`)
```javascript
static create({ projectId, taskId, role, section, content, embedding, importance, metadata }) → AgentMemory
static fromRow(row) → AgentMemory
// Поля: id, projectId, taskId, role, section, content, embedding, importance, compositeScore, ...
```

## Зависимости

```
AgentMemoryService
  ├── memoryRepo: IAgentMemoryRepo (PgAgentMemoryRepo)
  ├── embeddingEngine: IEmbeddingEngine (OllamaEmbeddingAdapter)
  ├── insightExtractor: IInsightExtractor (AgentInsightExtractor)
  └── knowledgeGraphService: KnowledgeGraphService (optional)
        ├── knowledgeGraphRepo: IKnowledgeGraphRepo (PgKnowledgeGraphRepo)
        └── kgEntityExtractor: IKGEntityExtractor (HaikuKGEntityExtractor)
```

DI wiring: `src/index.js`, строки 145-151.

## Текущее поведение

**Баг в #fuseWithGraphRRF (строка 120):**
Метод итерирует `vectorResults`, бустит score для пересечения с graphMemoryIds. Оставшиеся graph-only IDs (через `graphIdSet.delete`) отбрасываются. Для полной RRF нужно: fetch graph-only memories → назначить score → merge.

**Integration тесты (паттерн):**
Все `Pg*.test.js` используют `describe.skipIf(!process.env.DATABASE_URL)`. Setup: создаёт записи через repo, teardown: удаляет. Пример: `PgRunRepo.test.js`.
