# Task 002: Sprint 1 — Bootstrap проекта

## Тип
feature

## Приоритет
critical

## Описание
Поднять фундамент проекта с нуля: инициализировать Node.js, настроить Docker с PostgreSQL, создать схему БД, подготовить runtime-роли и тестовую инфраструктуру. После этого спринта проект запускается, подключается к БД, таблицы созданы, роли на месте.

## Acceptance Criteria

### package.json
- [ ] `package.json` с `"type": "module"`, `engines: { node: ">=22" }`
- [ ] Production: fastify, @fastify/cors, knex, pg, dotenv, yaml, pino, uuid
- [ ] Dev: vitest
- [ ] Scripts: start, dev, test, migrate
- [ ] `npm install` без ошибок

### Docker
- [ ] `docker-compose.yml`: postgres (pgvector:pg17), neuroforge (Node.js 22), ollama (optional profile)
- [ ] PostgreSQL: user=bot, password=bot, db=neuroforge, volume pgdata
- [ ] `Dockerfile`: multi-stage, Node.js 22 Alpine
- [ ] `.env.example` с описанием переменных
- [ ] `docker-compose up -d postgres` — PG работает

### Миграции
- [ ] `knexfile.js` (connection из DATABASE_URL)
- [ ] Миграция: таблицы users, api_keys, projects, sessions, tasks, task_steps, runs, message_log
- [ ] Индексы по архитектуре (key_hash, status, project_id, task_id, session_id)
- [ ] UUID primary keys, FK constraints, CASCADE
- [ ] `npm run migrate` / `npm run migrate:rollback` работают

### Runtime-роли
- [ ] `roles/`: default.md, analyst.md, developer.md, reviewer-architecture.md, reviewer-business.md, reviewer-security.md, tester.md, manager.md
- [ ] Frontmatter: name, model, timeout_ms, allowed_tools (по таблице из архитектуры)
- [ ] Body: полный system prompt для каждой роли

### Тесты
- [ ] `vitest.config.js` настроен
- [ ] Smoke-тест проходит
- [ ] `npm test` — 0 ошибок

## Контекст
- Блокирует все последующие спринты
- Схема БД: `docs/architecture/neuroforge.md` (раздел "Модель данных")
- Конфигурация ролей: таблица из архитектуры (model, timeout, tools)

## Затрагиваемые компоненты
- Infrastructure: Docker, PostgreSQL, Knex, vitest, roles

## Definition of Done
- [ ] `docker-compose up -d postgres` поднимает PG
- [ ] `npm run migrate` создаёт все таблицы
- [ ] `npm test` проходит
- [ ] 8 файлов в `roles/` с frontmatter + system prompt
- [ ] `docker build .` собирает образ
