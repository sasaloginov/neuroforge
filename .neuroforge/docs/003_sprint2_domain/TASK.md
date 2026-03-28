# Task 003: Sprint 2 — Domain Layer

## Тип
feature

## Приоритет
critical

## Описание
Реализовать полный domain-слой: entities с бизнес-логикой, value objects, доменные ошибки, порты (интерфейсы) и доменные сервисы. Покрыть unit-тестами. После этого спринта вся бизнес-логика работает без инфраструктуры — чистый domain, ноль внешних зависимостей.

## Acceptance Criteria

### Entities (`src/domain/entities/`)
- [ ] **Task.js**: factory create(), state machine (pending → in_progress → done/failed/cancelled), валидация переходов canTransitionTo(), revisionCount, fromRow()/toRow()
- [ ] **Run.js**: lifecycle (queued → running → done/failed/timeout/cancelled/interrupted), durationMs, fromRow()/toRow()
- [ ] **Session.js**: привязка к project + role, статусы (active/expired/closed), fromRow()/toRow()
- [ ] **TaskStep.js**: привязка к task, stepOrder, promptTemplate, fromRow()/toRow()

### Value Objects (`src/domain/valueObjects/`)
- [ ] **Role.js**: иммутабельный (name, model, timeoutMs, allowedTools, systemPrompt), валидация, equals()

### Errors (`src/domain/errors/`)
- [ ] **DomainError.js** — базовый класс
- [ ] **TaskNotFoundError**, **InvalidTransitionError**, **RoleNotFoundError**, **RunTimeoutError**, **RevisionLimitError**

### Ports (`src/domain/ports/`)
- [ ] **IChatEngine.js**: runPrompt(roleName, prompt, options) → { response, sessionId }
- [ ] **ITaskRepo.js**: findById, findByProjectId, save, delete
- [ ] **IRunRepo.js**: findById, findByTaskId, save, takeNext (очередь), findRunning
- [ ] **ISessionRepo.js**: findById, findByProjectAndRole, save, delete
- [ ] **IProjectRepo.js**: findById, findByName, save, findAll
- [ ] **ICallbackSender.js**: send(callbackUrl, payload, callbackMeta)
- [ ] Все порты — JSDoc с описанием сигнатур

### Services (`src/domain/services/`)
- [ ] **RoleRegistry.js**: register, get, has, getAll (Map<name, Role>)
- [ ] **TaskService.js**: createTask, advanceTask, failTask, cancelTask, проверка revision limit
- [ ] **RunService.js**: enqueue, start, complete, fail, timeout, interrupt

### Тесты
- [ ] Тесты для каждого entity (state machine, transitions, сериализация)
- [ ] Тесты Role (валидация, иммутабельность)
- [ ] Тесты RoleRegistry, TaskService, RunService
- [ ] Порты мокаются, реальная БД не нужна
- [ ] `npm test` — все зелёные

### Архитектурные требования
- [ ] **Ноль импортов** из application/infrastructure
- [ ] DI через конструкторы в сервисах
- [ ] SOLID, DRY, KISS

## Контекст
- Зависит от: Sprint 1 (Task 002)
- Схема entities: `docs/architecture/neuroforge.md` (раздел "Модель данных")
- Паттерны из mybot: Session.js, IChatEngine.js, ошибки

## Затрагиваемые компоненты
- Domain: entities, valueObjects, errors, ports, services

## Definition of Done
- [ ] Полный domain-слой реализован
- [ ] Ноль зависимостей от infrastructure
- [ ] Unit-тесты покрывают все модули
- [ ] `npm test` — все тесты проходят
