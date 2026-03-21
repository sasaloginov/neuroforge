# Task 006: Sprint 5 — Application Layer (Use Cases)

## Тип
feature

## Приоритет
critical

## Описание
Реализовать application-слой: use cases, которые оркестрируют domain-сервисы и порты для выполнения бизнес-сценариев. После этого спринта все ключевые сценарии работают end-to-end (с моками infrastructure).

## Acceptance Criteria

### Use Cases (`src/application/`)
- [ ] **CreateTask.js** — принять промпт, создать task, создать первый step (analyst), поставить run в очередь, вернуть taskId
- [ ] **ProcessRun.js** — взять run из очереди, запустить Claude CLI через IChatEngine, сохранить результат, отправить callback
- [ ] **ReplyToQuestion.js** — принять ответ от клиента, восстановить контекст, перевести задачу обратно в in_progress
- [ ] **CancelTask.js** — отменить задачу и все pending/queued runs
- [ ] **GetTaskStatus.js** — вернуть текущий статус задачи (для REST fallback)
- [ ] **ManagerDecision.js** — получить результат run, запустить manager-агента для решения о следующем шаге (spawn_run / ask_owner / complete_task / fail_task)

### Архитектурные требования
- [ ] Use cases зависят только от domain (ports, entities, services)
- [ ] DI через конструкторы
- [ ] Один use case — один файл
- [ ] SOLID, DRY, KISS

### Тесты
- [ ] Unit-тесты для каждого use case с мок-портами
- [ ] CreateTask: задача создаётся, первый run в очереди
- [ ] ProcessRun: run проходит полный lifecycle (queued → running → done), callback отправлен
- [ ] ReplyToQuestion: задача из waiting_reply → in_progress
- [ ] CancelTask: task + runs cancelled
- [ ] ManagerDecision: правильный следующий шаг на основе результата
- [ ] `npm test` — все зелёные

## Контекст
- Зависит от: Sprint 2 (domain), Sprint 3 (persistence ports), Sprint 4 (adapters)
- Архитектура: `docs/architecture/neuroforge.md`
- Use case pattern из mybot: `src/application/SendMessage.js`

## Затрагиваемые компоненты
- Application: `src/application/`

## Definition of Done
- [ ] 6 use cases реализованы
- [ ] Зависимость только от domain
- [ ] Unit-тесты покрывают все сценарии
- [ ] `npm test` — все тесты зелёные
