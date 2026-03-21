# Task 008: Sprint 7 — Manager + Worker + Composition Root

## Тип
feature

## Приоритет
critical

## Описание
Реализовать оркестрацию задач: Manager Scheduler (периодический тик, запускает ManagerDecision после завершения run), Worker (берёт run из очереди, выполняет через Claude CLI), Composition Root (src/index.js — DI, startup, graceful shutdown). После этого спринта Нейроцех работает end-to-end: POST /tasks → агент выполняет → callback приходит.

## Acceptance Criteria

### Worker (`src/infrastructure/scheduler/worker.js`)
- [ ] Функция/класс, вызывает ProcessRun use case в цикле (или по событию)
- [ ] Берёт run из очереди (ProcessRun.execute())
- [ ] После завершения run — вызывает ManagerDecision use case
- [ ] Ограничение параллельности: MANAGER_MAX_CONCURRENT
- [ ] Логирование: начало/конец run, ошибки

### Manager Scheduler (`src/infrastructure/scheduler/managerScheduler.js`)
- [ ] Периодический тик (MANAGER_INTERVAL_MS, default 10s)
- [ ] На каждом тике: запускает worker для обработки очереди
- [ ] Мониторинг timeout: находит running runs где started_at + timeout > now, помечает как timeout
- [ ] Recovery при старте: все running runs → interrupted
- [ ] start() / stop() для graceful shutdown
- [ ] MANAGER_ENABLED — можно отключить

### Composition Root (`src/index.js`)
- [ ] Загрузка конфига из ENV (dotenv)
- [ ] Создание PG-пула
- [ ] Загрузка ролей через FileRoleLoader → RoleRegistry
- [ ] Создание всех репозиториев
- [ ] Создание адаптеров (ClaudeCLIAdapter, CallbackClient)
- [ ] Создание domain services (TaskService, RunService)
- [ ] Создание use cases (CreateTask, ProcessRun, etc.)
- [ ] Создание и старт Fastify сервера
- [ ] Создание и старт ManagerScheduler
- [ ] Graceful shutdown: stop scheduler, close server, close PG pool
- [ ] Запуск миграций при старте (опционально)

### Тесты
- [ ] Worker: mock ProcessRun + ManagerDecision, проверка цикла
- [ ] ManagerScheduler: start/stop, tick вызывает worker, timeout monitoring
- [ ] Recovery: running runs → interrupted при старте
- [ ] `npm test` — все зелёные

## Контекст
- Зависит от: Sprint 5 (use cases), Sprint 6 (HTTP API)
- Архитектура: ADR #3 (manager + worker), ADR #25 (recovery)
- MANAGER_INTERVAL_MS=10000, MANAGER_MAX_CONCURRENT=3

## Затрагиваемые компоненты
- Infrastructure: scheduler/, index.js

## Definition of Done
- [ ] Worker обрабатывает очередь
- [ ] Manager тикает, мониторит timeout, recovery при старте
- [ ] index.js связывает всё вместе
- [ ] Graceful shutdown работает
- [ ] Тесты проходят
