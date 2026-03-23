# Research: RESEARCH_DONE статус и resume для research-задач

## Проблема

Сейчас research-задачи (mode=research) при завершении переходят в `DONE` — терминальный статус без исходящих переходов. Это означает:
1. Нельзя возобновить задачу и передать её в разработку
2. Нельзя уточнить исследование с новой инструкцией
3. `DONE` семантически означает «задача полностью завершена, включая деплой», что неверно для research-задач

## Текущее состояние

### State machine (Task.js)

```javascript
const TRANSITIONS = {
  backlog:          [pending, cancelled],
  pending:          [in_progress, cancelled],
  in_progress:      [waiting_reply, needs_escalation, done, failed, cancelled],
  waiting_reply:    [in_progress, cancelled],
  needs_escalation: [in_progress, cancelled],
  done:             [],        // ← терминальный, нет переходов
  failed:           [in_progress],
  cancelled:        [],
};
```

### Как research-задача завершается

`ManagerDecision.#handleResearchMode()` (строки 263-319):
1. Проверяет `task.mode === 'research'`
2. Находит последний analyst run со статусом `done`
3. Вызывает `taskService.completeTask(task.id)` → transition to `DONE`
4. Отправляет callback `{ type: 'done', mode: 'research', result: '...' }`
5. Вызывает `#tryStartNext(task.projectId)` → освобождает слот для следующей задачи

### Что сейчас блокирует resume

1. **State machine**: `DONE` → `[]` — нет переходов, `transitionTo()` бросит `InvalidTransitionError`
2. **Нет эндпоинта**: нет `POST /tasks/:id/resume`
3. **Нет use case**: нет `ResumeResearch`
4. **Slot**: при DONE выполнился `#tryStartNext` → слот может быть занят следующей задачей

### Как работает существующий `RestartTask`

`RestartTask` позволяет перезапустить `failed` → `in_progress`. Похожая механика, но:
- Только для `failed` статуса
- Не принимает `instruction` от владельца
- Использует `managerDecision.execute()` для решения следующего шага

### Как работает `ReplyToQuestion`

`ReplyToQuestion` обрабатывает ответ на `ask_owner`:
- `waiting_reply` → `in_progress`
- Enqueue того же роля с промптом «Ответ от владельца: ...»
- Паттерн полезен: формирует промпт с контекстом предыдущей работы

## Затрагиваемые файлы

### Domain
| Файл | Изменение |
|---|---|
| `src/domain/entities/Task.js` | Новый статус `RESEARCH_DONE`, переходы |
| `src/domain/valueObjects/TaskMode.js` | Без изменений |

### Application
| Файл | Изменение |
|---|---|
| `src/application/ManagerDecision.js` | `#handleResearchMode()`: RESEARCH_DONE вместо DONE |
| `src/application/ResumeResearch.js` | **НОВЫЙ** — use case для resume |
| `src/application/StartNextPendingTask.js` | Без изменений (RESEARCH_DONE не «active», слот свободен) |

### Infrastructure
| Файл | Изменение |
|---|---|
| `src/infrastructure/http/routes/taskRoutes.js` | Новый эндпоинт + schema |
| `src/infrastructure/persistence/PgTaskRepo.js` | Без изменений (читает status из БД, не хардкодит) |
| `src/infrastructure/persistence/migrations/007_*.js` | **НОВАЯ** — ALTER CHECK constraint |

### Критичные файлы оркестрации
| Файл | Затрагивается? |
|---|---|
| `src/infrastructure/claude/claudeCLIAdapter.js` | ❌ Нет |
| `src/infrastructure/scheduler/` | ❌ Нет |
| `src/index.js` | ⚠️ **ДА** — нужно добавить DI для ResumeResearch use case |
| `restart.sh` | ❌ Нет |

## Ключевые вопросы проектирования

### 1. RESEARCH_DONE — это active статус или нет?

**Ответ: НЕТ.** RESEARCH_DONE — это «паузный» статус: задача не активна (не занимает слот), но может быть возобновлена. Аналогично тому как `failed` не active, но имеет переход в `in_progress`.

Это важно для:
- `hasActiveTask()` — НЕ включает research_done (SQL: `status IN ('in_progress', 'waiting_reply', 'needs_escalation')`)
- `activateOldestPending()` — NOT EXISTS не проверяет research_done
- `#tryStartNext()` — можно запустить следующую задачу

### 2. Resume должен занять слот?

**ДА.** При resume задача переходит в `in_progress`, что занимает слот. Если слот занят другой задачей — resume должен fail с ошибкой (не ставить в pending, т.к. research-задача уже не pending).

**Альтернатива (выбрана):** Resume вызывает `activateIfNoActive()`. Если слот занят — возвращает ошибку. Владелец может retry позже.

### 3. Кого запускает resume — менеджера или конкретную роль?

**Менеджера.** Resume передаёт инструкцию менеджеру, который решает:
- Если инструкция «продолжи в разработку» → `spawn_run developer`
- Если инструкция «уточни ресёрч» → `spawn_run analyst`

Менеджер получает полный контекст: все предыдущие runs + инструкцию владельца.

### 4. Аналитик при повторном запуске — как берёт контекст?

Менеджер формирует промпт для аналитика, включая:
- Результаты предыдущего analyst run (response)
- Инструкцию владельца

Аналитик уже имеет доступ к файлам в ветке (research/context.md, design/spec.md), т.к. `ensureBranch` + `syncWorktrees` обновит код.

### 5. Нужна ли смена mode при resume?

**ДА, при resume mode автоматически меняется на `full`.** Если владелец говорит «продолжи в разработку», задача уже не research. Менеджер работает как обычно: developer → reviewers → tester → cto → done.

**Альтернатива:** Оставить mode=research и сменить в ManagerDecision. Но это усложняет логику.

**Выбор:** Resume всегда переводит mode в `full`. Это чистая семантика: «исследование закончено, теперь полный цикл».

## Риски

1. **Занятый слот**: Если между RESEARCH_DONE и resume запустилась другая задача, resume вернёт ошибку. Митигация: ошибка с HTTP 409 Conflict + подробным сообщением.
2. **mode=full после resume**: Если после resume снова запустится analyst, `#handleResearchMode` не сработает (mode уже full), и задача пойдёт по полному пайплайну. Это корректное поведение.
3. **Callback type**: Сейчас `type: 'done'` для research. Нужно заменить на `type: 'research_done'`, чтобы бот различал «ресёрч завершён, можно resume» от «задача полностью done».
