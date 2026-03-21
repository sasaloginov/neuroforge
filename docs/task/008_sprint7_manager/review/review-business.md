# Business Review — Sprint 7: Manager + Worker + Composition Root

**Reviewer:** Аркадий (business)
**Date:** 2026-03-21
**Verdict:** APPROVED with remarks

---

## Acceptance Criteria Check

### Worker (`src/infrastructure/scheduler/worker.js`)

| Criterion | Status | Notes |
|---|---|---|
| Функция/класс, вызывает ProcessRun use case в цикле (или по событию) | PASS | `createWorker` — фабрика, возвращает объект с `processOne()`. Цикл реализован в `ManagerScheduler.#runSlot()` |
| Берёт run из очереди (ProcessRun.execute()) | PASS | `processRun.execute()` вызывается, `null` означает пустую очередь |
| После завершения run — вызывает ManagerDecision use case | PASS | `managerDecision.execute({ completedRunId: run.id })` вызывается после успешного `processRun` |
| Ограничение параллельности: MANAGER_MAX_CONCURRENT | PASS | Реализовано в ManagerScheduler через `#maxConcurrent` и `#activeCount` |
| Логирование: начало/конец run, ошибки | PARTIAL | Ошибки логируются. Начало/конец конкретного run не логируется в worker — только ошибки. Допустимо, если ProcessRun сам логирует |

### Manager Scheduler (`src/infrastructure/scheduler/managerScheduler.js`)

| Criterion | Status | Notes |
|---|---|---|
| Периодический тик (MANAGER_INTERVAL_MS, default 10s) | PASS | `setInterval(() => this.tick(), this.#intervalMs)`, default 10000 |
| На каждом тике: запускает worker для обработки очереди | PASS | `tick()` запускает `#runSlot()` в свободные слоты |
| Мониторинг timeout: running runs где started_at + timeout > now | PASS | `checkTimeouts()` — находит running runs, сверяет elapsed с `role.timeoutMs + 30s buffer` |
| Recovery при старте: все running runs -> interrupted | PASS | `#recover()` вызывается в `start()`, помечает все running через `runService.interrupt()` |
| start() / stop() для graceful shutdown | PASS | `start()` запускает recover + interval. `stop()` ставит `#stopping`, ждёт drain до 30s |
| MANAGER_ENABLED — можно отключить | PASS | `config.enabled`, проверяется в `start()` — если false, ничего не делает |

### Composition Root (`src/index.js`)

| Criterion | Status | Notes |
|---|---|---|
| Загрузка конфига из ENV (dotenv) | PASS | `import 'dotenv/config'`, все параметры из `process.env` |
| Создание PG-пула | PASS | `createPool(config.databaseUrl)` |
| Загрузка ролей через FileRoleLoader -> RoleRegistry | PASS | `loadRoles()` + `roleRegistry.register()` |
| Создание всех репозиториев | PASS | TaskRepo, RunRepo, SessionRepo, ProjectRepo, UserRepo, ApiKeyRepo |
| Создание адаптеров (ClaudeCLIAdapter, CallbackClient) | PASS | Оба создаются |
| Создание domain services (TaskService, RunService) | PASS | Оба создаются с зависимостями |
| Создание use cases (CreateTask, ProcessRun, etc.) | PASS | 6 use cases: CreateTask, ProcessRun, ManagerDecision, GetTaskStatus, CancelTask, ReplyToQuestion |
| Создание и старт Fastify сервера | PASS | `createServer()` + `server.listen()` |
| Создание и старт ManagerScheduler | PASS | `createWorker()` + `new ManagerScheduler()` + `scheduler.start()` |
| Graceful shutdown: stop scheduler, close server, close PG pool | PASS | `setupShutdown()` — SIGINT/SIGTERM -> scheduler.stop -> server.close -> closePool |
| Запуск миграций при старте (опционально) | SKIP | Не реализовано. Миграции запускаются отдельной командой (`npm run migrate`). Приемлемо для текущей стадии |

### Тесты

| Criterion | Status | Notes |
|---|---|---|
| Worker: mock ProcessRun + ManagerDecision, проверка цикла | PASS | 5 тестов (TC-W1..W5) |
| ManagerScheduler: start/stop, tick вызывает worker, timeout monitoring | PASS | 9 тестов (TC-S1..S8, TC-S4b) |
| Recovery: running runs -> interrupted при старте | PASS | TC-S1 проверяет recovery |
| `npm test` — все зелёные | PASS | 252 passed, 30 skipped, 0 failed |

---

## Замечания

### 1. Логирование начала/конца run в worker (minor)

Worker логирует только ошибки. Для observability полезно добавить лог при входе в `processOne()` и после завершения, хотя бы на уровне debug. Не блокер.

### 2. Миграции при старте не реализованы (info)

Acceptance criteria помечает это как опциональное. Ручной запуск `npm run migrate` — нормальная практика для production. Замечание информационное.

### 3. Concurrency в tick() — потенциальный race condition (minor)

В `tick()` вычисление `slotsAvailable` и инкремент `#activeCount` не атомарны. Если два тика сработают одновременно (маловероятно при setInterval, но возможно при ручном вызове), может быть кратковременное превышение `maxConcurrent`. В однопоточном Node.js event loop это практически невозможно, но стоит иметь в виду.

### 4. ManagerDecision.execute — `crypto.randomUUID()` без импорта (info)

В `ManagerDecision.js` строка 116 использует `crypto.randomUUID()`. В Node.js 22 `crypto` доступен глобально, но для явности стоило бы добавить `import { randomUUID } from 'node:crypto'`. Не блокер.

---

## Итог

Все критические acceptance criteria выполнены. End-to-end flow `POST /tasks -> agent -> callback` полностью связан. Worker корректно обрабатывает очередь, ManagerScheduler обеспечивает тики, timeout-мониторинг и recovery. Graceful shutdown реализован правильно (scheduler -> server -> pool). Тесты покрывают все ключевые сценарии.

**Verdict: APPROVED**
