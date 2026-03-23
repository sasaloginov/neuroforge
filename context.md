# Task Context

## Затрагиваемые файлы

### Neuroforge (backend)

**`src/domain/valueObjects/TaskMode.js`** — Value object для режимов задачи
- `MODES = { FULL: 'full', RESEARCH: 'research' }` — добавить `AUTO: 'auto'`
- `isValidMode(mode)` — проверяет принадлежность к MODES

**`src/domain/entities/Task.js`** — Task entity
- `constructor()` строка 43: `this.mode = mode ?? 'full'` → менять default на `'auto'`
- `static create()` строка 56: `const validatedMode = mode ?? 'full'` → `'auto'`
- `static fromRow()` строка 109: `mode: row.mode ?? 'full'` → `'auto'`
- `isValidMode` импортируется из TaskMode.js, используется в create() для валидации

**`src/infrastructure/http/routes/taskRoutes.js`** — API route schemas
- `createTaskSchema.body.properties.mode` строка 14: `enum: ['full', 'research'], default: 'full'` → добавить `'auto'`, default `'auto'`

**`src/application/ManagerDecision.js`** — Оркестрация пайплайна
- `#handleResearchMode()` строка 264: `if (task.mode !== 'research') return null` — `auto` и `full` оба возвращают null → идут в LLM. Изменений НЕ нужно.
- `buildManagerPrompt()` строка 458: `Режим: ${task.mode ?? 'full'}` — будет показывать 'auto'. OK.

### mybot (клиент)

**`/root/bot/mybot/src/infrastructure/neuroforge/NeuroforgeClient.js`** — HTTP клиент
- `createTask(projectId, title, description, callbackUrl, callbackMeta)` строка 27 — добавить 6-й параметр `options = {}`
- `_request('POST', '/tasks', body)` — добавить `mode` из options в body

**`/root/bot/mybot/src/infrastructure/telegram/handlers/commandHandler.js`** — TG команды
- `bot.command('task', ...)` строка 392 — без изменений (не передаёт mode → default auto)
- Добавить `bot.command('research', ...)` — аналог task, но передаёт `{ mode: 'research' }`

## Ключевые сигнатуры

```javascript
// TaskMode.js
const MODES = { FULL: 'full', RESEARCH: 'research', AUTO: 'auto' };
function isValidMode(mode): boolean;

// Task.js
static create({ projectId, title, description, callbackUrl, callbackMeta, seqNumber, status, mode }): Task

// CreateTask.js — уже принимает mode, пробрасывает в taskService.createTask()
async execute({ projectId, title, description, callbackUrl, callbackMeta, status, mode }): Promise

// NeuroforgeClient.js (mybot)
async createTask(projectId, title, description, callbackUrl, callbackMeta, options = {}): Promise
```

## Зависимости

```
taskRoutes.js → CreateTask.execute({mode}) → TaskService.createTask({mode}) → Task.create({mode})
                                                                                    ↓
                                                                              isValidMode(mode) ← TaskMode.js
ManagerDecision → #handleResearchMode() → checks task.mode === 'research' only
```

## Текущее поведение

1. API default mode = `'full'` (в schema и entity)
2. `#handleResearchMode()` срабатывает ТОЛЬКО при `mode === 'research'`
3. Для `mode === 'full'` → менеджер LLM решает пайплайн (стандартный flow)
4. mybot НЕ передаёт mode → всегда default `'full'`
5. Добавление `auto` с тем же поведением что `full` — backward compatible
