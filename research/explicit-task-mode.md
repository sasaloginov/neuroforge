# Research: Явный параметр mode при создании задачи

## Текущее состояние

### Что уже реализовано
- **TaskMode.js** — value object с `MODES = { FULL: 'full', RESEARCH: 'research' }`, валидатор `isValidMode()`
- **Task.js** — поле `mode` в entity, default `'full'`, передаётся через `create()`, `fromRow()`, `toRow()`
- **CreateTask.js** — принимает `mode` в `execute()`, пробрасывает в `taskService.createTask()`
- **taskRoutes.js** — `mode: { type: 'string', enum: ['full', 'research'], default: 'full' }` в `createTaskSchema`
- **ManagerDecision.js** — `#handleResearchMode()` проверяет `task.mode !== 'research'`, auto-complete после analyst
- **PgTaskRepo.js** — `mode` сохраняется/загружается, колонка с default `'full'`
- **buildManagerPrompt()** — `Режим: ${task.mode ?? 'full'}` в промпте менеджера

### Что НЕ реализовано
- **Режим `auto`** отсутствует — нет в MODES, нет в enum, нет в isValidMode
- **NeuroforgeClient (mybot)** — метод `createTask()` НЕ принимает mode; вызывающий код (`/task` команда) не передаёт mode
- **Бот (commandHandler.js)** — нет команды `/research` или параметра mode для `/task`
- **Нет разницы в поведении** между `auto` и `full` — текущий default `full` = менеджер LLM решает пайплайн

## Проблема

1. **Из бота нельзя создать research-задачу** — `/task` команда не передаёт mode, всегда `full`
2. **Нет `auto` mode** — если клиент не знает нужный режим, он не может делегировать решение менеджеру
3. **Default `full` ≠ backward compatible для `auto`** — при добавлении `auto` нужно решить, чем он отличается от `full`

## Затрагиваемые файлы

### Neuroforge (backend)

| Файл | Изменение |
|------|-----------|
| `src/domain/valueObjects/TaskMode.js` | Добавить `AUTO: 'auto'` в MODES |
| `src/domain/entities/Task.js` | Default mode → `'auto'` вместо `'full'` |
| `src/infrastructure/http/routes/taskRoutes.js` | Добавить `'auto'` в enum, default → `'auto'` |
| `src/application/ManagerDecision.js` | `#handleResearchMode()` — обрабатывать `auto` как `full` (менеджер решает) |
| `src/infrastructure/persistence/migrations/` | Обновить CHECK constraint (если есть) |

### mybot (клиент)

| Файл | Изменение |
|------|-----------|
| `src/infrastructure/neuroforge/NeuroforgeClient.js` | Добавить `options` параметр с `mode` в `createTask()` |
| `src/infrastructure/telegram/handlers/commandHandler.js` | Команда `/research` или флаг `/task --research` |

## Семантика режимов

| Mode | Поведение | Кто решает пайплайн |
|------|----------|-------------------|
| `auto` | Default. Менеджер LLM решает после каждого шага | Manager LLM |
| `full` | Принудительно полный пайплайн: analyst → developer → reviewers → tester → cto | Manager LLM (но с подсказкой) |
| `research` | Только analyst → auto-complete (`research_done`) | Детерминистический (#handleResearchMode) |

### Разница `auto` vs `full`

**Вариант A: `auto` = `full` (поведение идентично)**
- За: Простота, backward compatible
- Против: Зачем два одинаковых значения?

**Вариант B: `auto` — менеджер может остановить после analyst, `full` — всегда продолжает до done**
- За: Семантически осмысленно
- Против: Сейчас менеджер и так решает; `full` потребует форсирования пайплайна в ManagerDecision

**Рекомендация: Вариант A.** `auto` и `full` идентичны по поведению. `auto` = "я не знаю, пусть система решит" = текущее поведение. `full` = "я знаю, что хочу полный цикл". Разница — в намерении вызывающего, не в поведении. Это позволяет в будущем добавить реальную auto-детекцию (LLM/heuristic), не ломая существующих клиентов.

## Риски

| Риск | Митигация |
|------|-----------|
| Миграция default `full` → `auto` ломает существующие задачи | Не меняем существующие записи. Новый default `auto` только для новых. Существующие `full` задачи продолжают работать |
| `auto` в промпте менеджера не информативен | Менеджер и так решает пайплайн; mode=auto не меняет его поведение |
| Ломка совместимости API | `auto` — default, старые клиенты без mode получают `auto` вместо `full`. Поведение идентично → нет ломки |
