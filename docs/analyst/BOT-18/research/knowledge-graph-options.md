# BOT-18: Knowledge Graph поверх текущей памяти — Исследование

## 1. Выбор хранилища для графа

### Вариант A: Apache AGE (PostgreSQL extension)

**Плюсы:**
- Работает внутри PostgreSQL — единая БД, единый бэкап, единый пул соединений
- openCypher-совместимый язык запросов
- Поддерживает PG 11-18, есть в Azure Database for PostgreSQL
- JOIN между графовыми и реляционными данными в одном запросе
- Есть Node.js driver (официальный)

**Минусы:**
- Требует установки C-extension в Docker (компиляция из исходников или пакет)
- Node.js driver (`apache-age-client`) — малое community, нестабильный API
- Cypher-запросы выполняются через SQL-обёртку `SELECT * FROM cypher('graph_name', $$ ... $$) AS (v agtype)` — неудобный DX
- Нет встроенной интеграции с pgvector
- Дополнительная сложность в миграциях (создание графа, вершин, рёбер — не через Knex)
- Overhead на поддержку extension в production

### Вариант B: Neo4j (отдельный сервис)

**Плюсы:**
- Зрелый продукт, лучшие в классе графовые алгоритмы
- Богатая экосистема (Neo4j + LangChain, LlamaIndex интеграции)
- Bolt driver для Node.js — стабильный

**Минусы:**
- Новый сервис в docker-compose (+память, +ops)
- Две БД = два источника правды, координация транзакций
- Community Edition — ограничения (одна БД)
- Overhead на синхронизацию данных между PG и Neo4j
- Нарушает принцип минимальной архитектуры

### Вариант C: Простые таблицы nodes + edges в PostgreSQL ✅ РЕКОМЕНДАЦИЯ

**Плюсы:**
- Нулевая инфраструктурная сложность — тот же PostgreSQL
- Knex-миграции, тот же pg pool, тот же CI
- Recursive CTEs покрывают 90% графовых запросов (expansion, path finding, subgraph)
- JSONB для гибких свойств узлов/рёбер
- Производительность: <10ms expansion (depth 2) на 10K nodes, <15ms path queries (depth 4)
- Можно JOIN с agent_memories и другими таблицами напрямую
- Проверенный подход (статья "Building a Personal KG with PostgreSQL", 2025)

**Минусы:**
- Нет Cypher — запросы на SQL/CTE (но для наших задач достаточно)
- Глубокий traversal (>4 hops) медленнее чем в native graph DB
- Нет встроенных graph-алгоритмов (PageRank, community detection) — но нам они не нужны

**Вывод:** Для масштаба Neuroforge (сотни-тысячи узлов на проект) вариант C оптимален. Мы получаем графовые возможности без новых зависимостей, без новых сервисов, с полной интеграцией в существующий стек.

---

## 2. Граф vs. Embedding Search — когда граф лучше?

### Embedding search хорош для:
- Семантический поиск по смыслу ("как мы решали проблему с производительностью?")
- Нечёткие запросы, когда пользователь не знает точных терминов
- Поиск по контенту (тексту инсайтов)

### Граф знаний хорош для:
- **Навигация по связям:** "Какие решения связаны с модулем X?" — 1-hop traversal
- **Причинно-следственные цепочки:** "Почему мы выбрали pgvector?" → решение → причина → альтернативы
- **Temporal queries:** "Что изменилось в архитектуре auth за последний месяц?"
- **Entity-centric retrieval:** "Всё что мы знаем про TaskService" — все связи конкретной сущности
- **Multi-hop reasoning:** "Какие тесты покрывают функционал, связанный с процессом оплаты?"
- **Disambiguation:** Когда два инсайта используют разные слова для одной сущности

### Исследования подтверждают:
- HybridRAG (NVIDIA + BlackRock, 2024): гибрид Graph+Vector > каждый по отдельности
- Practical GraphRAG (2025): гибрид с RRF показал +15% context precision vs. чистый vector search
- GraphRAG побеждает vector в 78.5% случаев на code-related задачах

---

## 3. Извлечение сущностей и связей из разговоров

### Подход: LLM-based extraction (Claude Haiku)

Уже есть `AgentInsightExtractor` — можно расширить или создать параллельный экстрактор.

**Промпт для extraction:**
```
Извлеки из текста сущности и связи для Knowledge Graph.

Сущности (nodes):
- module: компонент системы (TaskService, PgTaskRepo, etc.)
- concept: архитектурный концепт (DDD, CQRS, Event Sourcing)
- decision: принятое решение (выбор pgvector, UUID как PK)
- technology: технология (PostgreSQL, Fastify, Claude)
- pattern: паттерн (Repository, Port/Adapter)
- problem: проблема/баг
- person: участник

Связи (edges):
- USES: module → technology
- DEPENDS_ON: module → module
- IMPLEMENTS: module → pattern/concept
- DECIDED: decision → concept/technology
- CAUSED_BY: problem → module
- RESOLVED_BY: problem → decision
- RELATES_TO: generic relation

Формат ответа (JSON):
{
  "entities": [{"name": "...", "type": "module|concept|...", "properties": {}}],
  "relations": [{"source": "...", "target": "...", "type": "USES|...", "properties": {}}]
}
```

### Альтернатива: Dependency Parsing (без LLM)

- SpaCy + subject-verb-object extraction
- 94% качества LLM при нулевых затратах на API
- НО: требует Python/SpaCy → дополнительный сервис → не подходит для Node.js стека

### Рекомендация для MVP:
- Использовать Claude Haiku (уже есть Anthropic SDK) для entity+relation extraction
- Вызывать параллельно с insight extraction (или объединить в один вызов)
- Entity resolution через normalized_name (lowercase, trim)
- Dedup через UNIQUE constraint на (project_id, entity_type, normalized_name)

---

## 4. Объединение графового поиска с RRF

### Текущий RRF (2 сигнала):
```
RRF_score = 1/(k + vector_rank) + 1/(k + text_rank)
```

### Предлагаемый RRF (3 сигнала):
```
RRF_score = w_v × 1/(k + vector_rank) + w_t × 1/(k + text_rank) + w_g × 1/(k + graph_rank)
```

Где `graph_rank` определяется по:
1. Извлечь entities из запроса (NER или keyword match)
2. Найти в графе узлы, соответствующие entities
3. Выполнить 1-2 hop traversal, собрать связанные memory IDs
4. Ранжировать по: расстояние от seed node + confidence связи
5. Вернуть ranked list → подать в RRF

### Веса (начальные, подбирать эмпирически):
- `w_v = 1.0` (vector — основной сигнал)
- `w_t = 1.0` (text — полнотекстовый)
- `w_g = 0.7` (graph — дополнительный, меньший вес на старте)
- `k = 60` (как сейчас)

### Обогащение контекста:
Помимо RRF, граф даёт **дополнительный контекст**:
- К найденным memories добавить связанные entities и их relations
- Форматировать как XML-блок `<knowledge_graph>` рядом с `<project_memory>`

---

## 5. Оценка сложности и MVP

### MVP Scope:

| Компонент | Сложность | Описание |
|-----------|-----------|----------|
| Миграция: таблицы kg_entities + kg_relations | Low | 2 таблицы, индексы |
| Порт IKnowledgeGraphRepo | Low | 5-6 методов |
| PgKnowledgeGraphRepo | Medium | CRUD + recursive CTE queries |
| KGEntityExtractor (Claude Haiku) | Medium | Промпт + парсинг JSON |
| Интеграция в AgentMemoryService | Medium | Entity extraction при storeFromResponse |
| Graph retrieval в search pipeline | Medium | Entity matching + traversal + RRF integration |
| Тесты | Medium | Unit + integration |

### Estimated effort: 3-5 дней разработки

### Что НЕ входит в MVP:
- Graph visualization UI
- Community detection / PageRank
- Автоматический entity resolution через embeddings (только normalized_name)
- Обратная связь (пользователь подтверждает/отвергает сущности)
- Граф между проектами (только per-project)

### Зависимости:
- Anthropic SDK (уже есть) для Claude Haiku extraction
- Текущая БД PostgreSQL (таблицы в той же схеме)
- Ollama + BGE-M3 (уже есть) — можно добавить embeddings к nodes для entity matching

### Риски:
1. **Качество extraction:** Haiku может генерировать невалидные/неконсистентные сущности → нужна валидация
2. **Entity resolution:** Одна и та же сущность под разными именами → normalized_name не всегда достаточно
3. **Шум в графе:** Слишком много low-confidence связей → нужен threshold
4. **Latency:** Дополнительный graph traversal в search pipeline → нужно мониторить
5. **Cost:** Дополнительный LLM вызов (Haiku) на каждый run → ~$0.001-0.005 per run

Sources:
- [HybridRAG: Integrating KGs and Vector RAG](https://arxiv.org/abs/2408.04948)
- [Practical GraphRAG: Efficient KG Construction and Hybrid Retrieval at Scale](https://arxiv.org/abs/2507.03226)
- [Building a Personal KG with PostgreSQL](https://dev.to/micelclaw/4o-building-a-personal-knowledge-graph-with-just-postgresql-no-neo4j-needed-22b2)
- [Apache AGE Documentation](https://age.apache.org/)
- [Neo4j: Knowledge Graph vs Vector RAG](https://neo4j.com/blog/developer/knowledge-graph-vs-vector-rag/)
- [LLM-empowered KG Construction Survey](https://arxiv.org/html/2510.20345v1)
