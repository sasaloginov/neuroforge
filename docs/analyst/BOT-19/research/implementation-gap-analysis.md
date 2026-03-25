# BOT-19: Gap Analysis — Knowledge Graph Implementation

## Состояние реализации

Коммит `3ca5049` (BOT-18) уже содержит полную реализацию Knowledge Graph по спецификации BOT-18.

### Реализованные компоненты (✅ полностью)

| Компонент | Файл | Статус |
|-----------|------|--------|
| Миграция | `migrations/20260325_012_knowledge_graph.js` | ✅ 2 таблицы + 6 индексов |
| KGEntity VO | `domain/valueObjects/KGEntity.js` | ✅ + 10 unit-тестов |
| KGRelation VO | `domain/valueObjects/KGRelation.js` | ✅ + 8 unit-тестов |
| IKnowledgeGraphRepo | `domain/ports/IKnowledgeGraphRepo.js` | ✅ 7 методов |
| IKGEntityExtractor | `domain/ports/IKGEntityExtractor.js` | ✅ 1 метод |
| PgKnowledgeGraphRepo | `infrastructure/persistence/PgKnowledgeGraphRepo.js` | ✅ 7 методов |
| HaikuKGEntityExtractor | `infrastructure/claude/haikuKGEntityExtractor.js` | ✅ extraction + validation |
| KnowledgeGraphService | `domain/services/KnowledgeGraphService.js` | ✅ + 7 unit-тестов |
| AgentMemoryService | `domain/services/AgentMemoryService.js` | ✅ KG integration |
| DI wiring | `index.js` | ✅ 3 новых экземпляра |

### Пробелы (❌ отсутствуют)

| Что отсутствует | Критичность | Обоснование |
|-----------------|-------------|-------------|
| `HaikuKGEntityExtractor.test.js` | HIGH | Нет тестов парсинга JSON, невалидного ответа, обрезки текста |
| `PgKnowledgeGraphRepo.test.js` (integration) | HIGH | Нет проверки CTE traversal, upsert dedup, cycle prevention |
| `AgentMemoryService.test.js` | MEDIUM | Нет тестов RRF fusion с graph, storeFromResponse + KG, graceful degradation |

### Качество существующего кода

1. **KnowledgeGraphService** — корректно реализует extractAndStore и findRelatedMemories. Тесты покрывают основные сценарии (happy path, empty, unknown entities, limit).

2. **PgKnowledgeGraphRepo** — recursive CTE корректный, предотвращает циклы (`NOT (e2.id = ANY(gw.path))`), фильтрует по confidence (`>= 0.5`). UPSERT merge на entities (`|| EXCLUDED.properties`) и relations (`GREATEST confidence`).

3. **HaikuKGEntityExtractor** — валидирует типы, обрезает лимиты (15 entities / 20 relations), проверяет что связи ссылаются на извлечённые entities. Fallback на `{ entities: [], relations: [] }`.

4. **AgentMemoryService** — KG injection optional (backward compatible), `#fuseWithGraphRRF` корректно бустит scores, fire-and-forget для KG extraction с `.catch()`.

5. **Потенциальный баг:** В `#fuseWithGraphRRF` — memories, найденные ТОЛЬКО через граф (не через vector), не включаются в результат. Метод только бустит vector results, не добавляет graph-only memories. Это расхождение со спекой BOT-18, где предполагалось что graph-only memories тоже попадают в результат.

## Вывод

Задача BOT-19 сводится к:
1. Добавить недостающие тесты (3 файла)
2. Исправить потенциальный баг с graph-only memories в RRF fusion
3. Проверить миграцию на реальной БД
