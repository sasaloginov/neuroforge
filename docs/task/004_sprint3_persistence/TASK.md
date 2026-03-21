# Task 004: Sprint 3 — Persistence Layer

## Тип
feature

## Приоритет
critical

## Описание
Реализовать infrastructure-слой persistence: PG-пул, все репозитории (реализации портов из domain), FileRoleLoader для загрузки ролей из `roles/*.md`. После этого спринта данные сохраняются в PostgreSQL, роли загружаются из файлов.

## Acceptance Criteria

### PG-пул (`src/infrastructure/persistence/pg.js`)
- [ ] `createPool(connectionString)` — инициализация пула
- [ ] `getPool()` — singleton accessor
- [ ] `closePool()` — graceful shutdown

### Репозитории (`src/infrastructure/persistence/`)
- [ ] **PgTaskRepo.js** — реализует ITaskRepo: findById, findByProjectId (с фильтром по status), save (upsert), delete
- [ ] **PgRunRepo.js** — реализует IRunRepo: findById, findByTaskId, findRunning, save (upsert), takeNext (`SELECT ... FOR UPDATE SKIP LOCKED` из очереди)
- [ ] **PgSessionRepo.js** — реализует ISessionRepo: findById, findByProjectAndRole, save (upsert), delete
- [ ] **PgProjectRepo.js** — реализует IProjectRepo: findById, findByName, save (upsert), findAll
- [ ] **PgUserRepo.js** — findById, findByRole, save, delete
- [ ] **PgApiKeyRepo.js** — findByHash (для auth), save, findByUserId, delete
- [ ] Все репозитории используют entity.fromRow()/toRow() для маппинга

### FileRoleLoader (`src/infrastructure/roles/fileRoleLoader.js`)
- [ ] Читает все `roles/*.md` файлы
- [ ] Парсит YAML frontmatter (name, model, timeout_ms, allowed_tools)
- [ ] Извлекает body как systemPrompt
- [ ] Возвращает массив Role value objects
- [ ] Ошибка при невалидном frontmatter

### Integration-тесты
- [ ] Тесты репозиториев на реальной test-БД (neuroforge_test)
- [ ] Тест `takeNext()` — корректная работа очереди
- [ ] Тест FileRoleLoader — парсинг реальных `roles/*.md`
- [ ] `npm test` — все тесты зелёные

## Контекст
- Зависит от: Sprint 2 (domain layer — ports, entities)
- PG-пул паттерн из mybot: `src/infrastructure/persistence/pg.js`
- Очередь: `FOR UPDATE SKIP LOCKED` (ADR #5)

## Затрагиваемые компоненты
- Infrastructure: persistence/, roles/

## Definition of Done
- [ ] Все 6 репозиториев реализуют порты
- [ ] FileRoleLoader парсит roles/*.md
- [ ] takeNext() работает с конкурентным доступом
- [ ] Integration-тесты проходят
