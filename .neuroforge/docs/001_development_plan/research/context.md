# Research: Task 001 — План разработки Нейроцеха

## Текущее состояние проекта

### Что есть
| Компонент | Статус | Файлы |
|-----------|--------|-------|
| Архитектурный док | Готов | `docs/architecture/neuroforge.md` (750 строк, 34 ADR) |
| Агенты Claude Code | Готовы | `.claude/agents/` — 7 агентов |
| Шаблоны задач | Готовы | `docs/templates/` — TASK.md, STATUS.md, ADR.md |
| Процесс разработки | Готов | `docs/process/` — workflow.md, agent-guide.md |
| CLAUDE.md | Готов | Конвенции, стек, DDD-правила |

### Чего нет
| Компонент | Статус |
|-----------|--------|
| `src/` | Не создан — нет ни строчки кода |
| `package.json` | Не создан |
| `roles/` | Не создан (runtime-роли для агентов) |
| `Dockerfile` / `docker-compose.yml` | Не созданы |
| Миграции БД | Не созданы |
| Тесты | Нет |

## Код-донор из mybot

Из `/root/bot/mybot/` можно переиспользовать:

| Компонент | Файл в mybot | Адаптация |
|-----------|-------------|-----------|
| **ClaudeCLIAdapter** | `src/infrastructure/claude/ClaudeCLIAdapter.js` | Убрать chatId → заменить на runId, убрать Telegram-специфику |
| **Session entity** | `src/domain/entities/Session.js` | Добавить roleId, убрать chatId |
| **PG-пул** | `src/infrastructure/persistence/pg.js` | Копировать as-is |
| **Миграции** | `src/infrastructure/persistence/migrate.js` | Копировать runner, новые SQL |
| **Порты** | `src/domain/ports/IChatEngine.js` | Адаптировать сигнатуру |
| **Ошибки** | `src/domain/errors/*.js` | Расширить новыми типами |
| **Composition Root** | `src/index.js` | Использовать паттерн DI |

## Граф зависимостей компонентов

```
                    ┌─────────────┐
                    │  roles/*.md │ (файлы на диске)
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │FileRoleLoader│
                    └──────┬──────┘
                           │
┌──────────┐        ┌──────▼──────┐        ┌──────────────┐
│ Entities │◄───────│RoleRegistry │        │  PostgreSQL   │
│Task, Run,│        └─────────────┘        └──────┬───────┘
│Session   │                                      │
└────┬─────┘        ┌─────────────┐        ┌──────▼───────┐
     │              │   Ports     │◄───────│  Pg*Repo     │
     │              │IChatEngine  │        │PgTaskRepo    │
     │              │ITaskRepo    │        │PgRunRepo     │
     │              │IRunRepo     │        │PgSessionRepo │
     │              └──────┬──────┘        └──────────────┘
     │                     │
     │              ┌──────▼──────┐        ┌──────────────┐
     └──────────────│  Services   │        │ClaudeCLI     │
                    │TaskService  │◄───────│Adapter       │
                    │RunService   │        └──────────────┘
                    │ManagerSvc   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐        ┌──────────────┐
                    │  Use Cases  │        │CallbackClient│
                    │CreateTask   │────────│(HTTP POST)   │
                    │ProcessRun   │        └──────────────┘
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐ ┌──▼─────┐ ┌───▼──────┐
       │Fastify HTTP  │ │Manager │ │Worker    │
       │Routes        │ │Scheduler│ │(claude -p)│
       └──────────────┘ └────────┘ └──────────┘
                           │
                    ┌──────▼──────┐
                    │  index.js   │ (Composition Root)
                    └─────────────┘
```

## Порядок реализации (по зависимостям)

Компоненты образуют чёткий DAG — каждый следующий слой зависит от предыдущих:

1. **Фундамент** — package.json, Docker, PG, миграции
2. **Domain** — entities, value objects, ports, errors (зависимость: ничего)
3. **Infrastructure/Persistence** — PgRepos, pg-pool (зависимость: domain + PG)
4. **Infrastructure/Roles** — FileRoleLoader + roles/*.md (зависимость: domain)
5. **Infrastructure/Claude** — ClaudeCLIAdapter (зависимость: domain)
6. **Infrastructure/Callback** — CallbackClient (зависимость: domain)
7. **Application** — use cases (зависимость: domain + ports)
8. **Infrastructure/HTTP** — Fastify routes + auth (зависимость: application)
9. **Infrastructure/Scheduler** — Manager + Worker (зависимость: application + claude + persistence)
10. **Composition Root** — index.js (зависимость: всё)

---

## Спринты разработки

### Sprint 1: Фундамент (Bootstrap)
**Цель:** Проект запускается, подключается к БД, таблицы созданы.

**Задачи:**
| # | Задача | Deliverable |
|---|--------|-------------|
| 1.1 | Создать `package.json` с зависимостями | fastify, knex, pg, vitest, dotenv, yaml |
| 1.2 | Создать `docker-compose.yml` | PostgreSQL 17 (pgvector) |
| 1.3 | Создать `Dockerfile` | Node.js 22 Alpine |
| 1.4 | Написать миграции | 8 таблиц: users, api_keys, projects, sessions, tasks, task_steps, runs, message_log |
| 1.5 | Создать `roles/*.md` | 8 ролей: default, analyst, developer, reviewer-*, tester, manager |
| 1.6 | Настроить vitest | `vitest.config.js`, первый smoke-тест |

**Acceptance Criteria:**
- `docker-compose up -d postgres` поднимает PG
- `npm run migrate` создаёт все таблицы
- `npx vitest run` — 0 тестов, 0 ошибок
- `roles/*.md` содержат frontmatter + system prompt

---

### Sprint 2: Domain Layer
**Цель:** Чистая бизнес-логика без зависимостей от инфраструктуры.

**Задачи:**
| # | Задача | Deliverable |
|---|--------|-------------|
| 2.1 | Entities | `Task.js`, `Run.js`, `Session.js`, `TaskStep.js` |
| 2.2 | Value Objects | `Role.js` (name, model, timeout, tools, systemPrompt) |
| 2.3 | Domain Errors | `TaskNotFoundError`, `InvalidTransitionError`, `RoleNotFoundError`, `TimeoutError` |
| 2.4 | Ports | `IChatEngine.js`, `ITaskRepo.js`, `IRunRepo.js`, `ISessionRepo.js`, `IProjectRepo.js` |
| 2.5 | Domain Services | `TaskService.js` (state machine), `RunService.js` (execution), `RoleRegistry.js` |
| 2.6 | Unit-тесты | Тесты для entities, services, state machine |

**Acceptance Criteria:**
- Task entity: создание, смена статусов (state machine с валидацией переходов)
- Run entity: queued → running → done/failed/timeout
- RoleRegistry: регистрация, поиск, валидация role_name
- TaskService: создание задачи, продвижение по этапам
- 100% покрытие domain-слоя тестами
- **Ноль импортов из infrastructure**

---

### Sprint 3: Persistence Layer
**Цель:** Данные сохраняются в PostgreSQL.

**Задачи:**
| # | Задача | Deliverable |
|---|--------|-------------|
| 3.1 | PG-пул | `pg.js` — createPool/getPool/closePool |
| 3.2 | PgTaskRepo | CRUD + фильтрация по статусу |
| 3.3 | PgRunRepo | CRUD + `takeNext()` (FOR UPDATE SKIP LOCKED) |
| 3.4 | PgSessionRepo | CRUD + привязка к run |
| 3.5 | PgProjectRepo | CRUD + поиск по name |
| 3.6 | PgUserRepo + PgApiKeyRepo | CRUD + auth (key_hash lookup) |
| 3.7 | FileRoleLoader | Парсинг `roles/*.md` → Role value objects |
| 3.8 | Integration-тесты | Тесты репозиториев на реальной БД |

**Acceptance Criteria:**
- `PgRunRepo.takeNext()` корректно работает с конкурентными воркерами
- FileRoleLoader парсит frontmatter (YAML) + markdown body
- Все репозитории реализуют соответствующие порты
- Integration-тесты проходят на test-БД

---

### Sprint 4: Claude CLI Adapter + Callback
**Цель:** Нейроцех может запускать Claude CLI и отправлять callback.

**Задачи:**
| # | Задача | Deliverable |
|---|--------|-------------|
| 4.1 | ClaudeCLIAdapter | Адаптировать из mybot: spawn `claude -p`, роль → CLI-флаги |
| 4.2 | MCP config | Генерация `mcp-config.json` для агентов (report_progress, ask_question, complete) |
| 4.3 | CallbackClient | HTTP POST на callbackUrl с retry |
| 4.4 | Тесты | Unit-тесты с мок-процессом, integration-тест CallbackClient |

**Acceptance Criteria:**
- ClaudeCLIAdapter запускает `claude -p --session-id X --system-prompt Y --model Z`
- Таймаут: soft (SIGTERM) + hard (SIGKILL)
- CallbackClient отправляет 4 типа callback (progress, question, done, failed)
- callbackMeta проходит прозрачно (не интерпретируется)

---

### Sprint 5: Application Layer (Use Cases)
**Цель:** Бизнес-сценарии работают end-to-end.

**Задачи:**
| # | Задача | Deliverable |
|---|--------|-------------|
| 5.1 | CreateTask | Принять промпт → создать task + первый step |
| 5.2 | ProcessRun | Взять run из очереди → запустить Claude CLI → сохранить результат → callback |
| 5.3 | ReplyToQuestion | Принять ответ → восстановить контекст → продолжить |
| 5.4 | CancelTask | Отменить задачу + все pending runs |
| 5.5 | GetTaskStatus | Вернуть текущий статус для REST fallback |
| 5.6 | ManagerDecision | Менеджер принимает решение о следующем шаге |
| 5.7 | Тесты | Unit-тесты use cases с мок-портами |

**Acceptance Criteria:**
- CreateTask: задача создаётся со статусом pending, первый run — analyst
- ProcessRun: run queued → running → done, response сохранён
- ReplyToQuestion: задача из AWAITING_INPUT продолжается
- CancelTask: все runs cancelled, task cancelled
- ManagerDecision: менеджер выбирает next step на основе результата

---

### Sprint 6: HTTP API + Auth
**Цель:** REST API доступен клиентам.

**Задачи:**
| # | Задача | Deliverable |
|---|--------|-------------|
| 6.1 | Fastify server | Setup, CORS, error handling, graceful shutdown |
| 6.2 | Auth middleware | Bearer token → SHA-256 → lookup api_keys → scope validation |
| 6.3 | Task routes | POST /tasks, POST /tasks/:id/reply, POST /tasks/:id/cancel, GET /tasks/:id |
| 6.4 | Project routes | POST /projects, GET /projects, GET /projects/:name, GET /projects/:name/tasks |
| 6.5 | Admin routes | POST /users, GET /users, DELETE /users/:id, POST /api-keys, GET /api-keys |
| 6.6 | CLI bootstrap | `node cli.js create-admin --name "..."` |
| 6.7 | JSON Schema validation | Fastify schema для всех endpoints |
| 6.8 | API-тесты | Тесты endpoints с supertest/light-my-request |

**Acceptance Criteria:**
- Все endpoints из архитектурного дока работают
- Auth: невалидный/просроченный токен → 401
- Scope: ключ с project_id видит только свой проект
- Schema validation: невалидный body → 400 с описанием
- `create-admin` создаёт первого пользователя + API-ключ

---

### Sprint 7: Manager + Worker
**Цель:** Полный цикл оркестрации задач.

**Задачи:**
| # | Задача | Deliverable |
|---|--------|-------------|
| 7.1 | ManagerScheduler | Периодический тик (MANAGER_INTERVAL_MS), LISTEN/NOTIFY |
| 7.2 | Worker | `node worker.js` — берёт run, выполняет, выходит |
| 7.3 | Manager logic | LLM-агент: анализ результата → spawn_run / ask_owner / complete_task / fail_task |
| 7.4 | Параллельные runs | 3 ревьюера одновременно, ждём все 3 |
| 7.5 | Timeout handling | Мониторинг running runs, timeout → interrupted |
| 7.6 | Recovery | При рестарте: running → interrupted, restart по правилам роли |
| 7.7 | Revision limit | max 5 итераций review ↔ code |
| 7.8 | Composition root | `src/index.js` — DI, startup, graceful shutdown |
| 7.9 | Integration-тесты | E2E тест полного цикла задачи (mock Claude CLI) |

**Acceptance Criteria:**
- Manager запускает analyst → developer → 3 reviewers → tester
- Worker берёт run из очереди (FOR UPDATE SKIP LOCKED)
- Параллельные ревьюеры работают, manager ждёт все 3
- Timeout: running > timeout_ms → interrupted → recovery
- При рестарте: interrupted runs восстанавливаются
- Revision count > 5 → task failed
- Graceful shutdown: не теряет running runs

---

### Sprint 8: Docker + Deploy + Polish
**Цель:** Нейроцех работает в Docker, готов к продакшну.

**Задачи:**
| # | Задача | Deliverable |
|---|--------|-------------|
| 8.1 | Dockerfile production | Multi-stage build, Node.js 22 Alpine |
| 8.2 | docker-compose.yml | neuroforge + postgres + ollama (optional) |
| 8.3 | Health check | GET /health — БД, роли загружены, manager active |
| 8.4 | Logging | Structured logging (pino), уровни, request ID |
| 8.5 | Config validation | Все ENV проверяются при старте, fail-fast |
| 8.6 | Init CLI | `neuroforge init <name> --repo-url X` — setup-агент |
| 8.7 | README.md | Quick start, API reference, deployment guide |
| 8.8 | E2E тест | Полный цикл через Docker: создать задачу → получить callback done |

**Acceptance Criteria:**
- `docker-compose up` — Нейроцех работает
- Health check возвращает статус всех компонентов
- `neuroforge init` клонирует репо, запускает setup-агента
- E2E тест проходит в CI

---

## Приоритеты и зависимости между спринтами

```
Sprint 1 (Bootstrap)
    │
    ▼
Sprint 2 (Domain) ────────────────┐
    │                              │
    ▼                              │
Sprint 3 (Persistence) ◄──────────┤
    │                              │
    ▼                              │
Sprint 4 (Claude CLI + Callback)  │
    │                              │
    ▼                              ▼
Sprint 5 (Use Cases) ◄── Sprint 2 + 3 + 4
    │
    ▼
Sprint 6 (HTTP API) ◄── Sprint 5
    │
    ▼
Sprint 7 (Manager + Worker) ◄── Sprint 5 + 6
    │
    ▼
Sprint 8 (Docker + Deploy) ◄── Sprint 7
```

**Критический путь:** 1 → 2 → 3 → 5 → 7

**Параллелизация возможна:**
- Sprint 3 (Persistence) и Sprint 4 (Claude CLI) — параллельно после Sprint 2
- Sprint 6 (HTTP API) и Sprint 7 (Manager) — частично параллельно после Sprint 5

## Риски

| Риск | Вероятность | Митигация |
|------|------------|-----------|
| Claude CLI API изменится | Средняя | Абстракция через порт IChatEngine |
| Нехватка RAM (3.8 ГБ) | Высокая | Swap 4+ ГБ, MANAGER_MAX_CONCURRENT=2 |
| Сложность MCP-интеграции | Средняя | Можно начать без MCP, добавить позже |
| Конкурентность очереди | Низкая | FOR UPDATE SKIP LOCKED — проверенный паттерн |
| Timeout management | Средняя | Начать с простого SIGTERM, усложнить по необходимости |

## Открытые вопросы

1. **MCP сервер** — реализовывать в Sprint 4 или отложить? Можно начать с stdout-парсинга и добавить MCP позже
2. **Knex vs raw SQL** — Knex добавляет абстракцию, но raw SQL проще для FOR UPDATE SKIP LOCKED
3. **Worker как отдельный процесс или поток?** — Архитектура говорит `node worker.js` (отдельный процесс)
4. **LISTEN/NOTIFY** — реализовывать сразу или начать с polling?
