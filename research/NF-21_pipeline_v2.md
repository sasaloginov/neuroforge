# Research: Pipeline v2 — session-based агенты с PM-оркестратором

## 1. Текущая архитектура пайплайна

### Процесс выполнения задачи (v1)

```
CreateTask → enqueue(analyst)
  ↓
Worker.processOne():
  ProcessRun.execute() → takeNext() → chatEngine.runPrompt()
  ManagerDecision.execute() → LLM manager → spawn_run(developer)
  ↓
Worker.processOne():
  ProcessRun.execute() → developer run
  ManagerDecision.execute() → LLM manager → spawn_runs(reviewer×3)
  ↓
Worker.processOne() ×3:
  ProcessRun.execute() → reviewer runs (parallel)
  ManagerDecision.execute() → #handleReviewFindings() → revision_cycle/LLM
  ↓
... tester → cto → complete_task
```

### Проблемы

| Проблема | Impact | Пример |
|----------|--------|--------|
| Каждый агент обходит кодовую базу заново | 60-75% input tokens | Analyst читает 30 файлов → developer читает те же 30 |
| Manager LLM вызывается между каждым шагом | $0.3-0.5 за вызов × 6-8 шагов | buildManagerPrompt включает ВСЮ историю |
| 3 reviewer'а строят один контекст | ×3 стоимость ревью | Каждый делает git diff + читает одни файлы |
| Tester дублирует developer'а | +$1-2 за задачу | Developer и так пишет тесты |
| CTO — LLM для git merge | +$0.5 за задачу | 5 bash-команд, LLM избыточен |
| Session per project+role | Нет isolation между задачами | Стоимость типичной задачи: **$7-8** |

### Текущие затраты (NF-20 метрики)

```
analyst:     $1.84  (1 run)
developer:   $2.69  (1-2 runs)
reviewer×3:  $1.74  (3 runs parallel)
tester:      $0.80  (1 run)
cto:         $0.50  (1 run)
manager:     $0.50  (4-6 LLM calls)
revision:    $1.50  (1-2 cycles average)
─────────────────────
ИТОГО:       ~$7-8
```

## 2. Анализ затрагиваемых компонентов

### Компоненты, требующие ИЗМЕНЕНИЯ

| Компонент | Файл | Суть изменения |
|-----------|------|---------------|
| Session entity | `src/domain/entities/Session.js` | Добавить `taskId` для session per task+role |
| PgSessionRepo | `src/infrastructure/persistence/PgSessionRepo.js` | `findOrCreate(projectId, roleName)` → `findOrCreate(taskId, roleName)` |
| ManagerDecision | `src/application/ManagerDecision.js` | **Переписать**: детерминистические переходы + LLM только для edge cases |
| ProcessRun | `src/application/ProcessRun.js` | Session sharing analyst→developer через taskId |
| CreateTask | `src/application/CreateTask.js` | Первый run = PM (не analyst) |
| StartNextPendingTask | `src/application/StartNextPendingTask.js` | Первый run = PM (не analyst) |
| ReplyToQuestion | `src/application/ReplyToQuestion.js` | Reply → enqueue PM (не последнюю роль) |
| RestartTask | `src/application/RestartTask.js` | Restart → enqueue PM |
| Worker | `src/infrastructure/scheduler/worker.js` | Без изменений (processRun → managerDecision) |
| ManagerScheduler | `src/infrastructure/scheduler/managerScheduler.js` | Без изменений |
| Миграция | `migrations/` | Добавить `task_id` в sessions, unique(task_id, role_name) |

### Компоненты, требующие СОЗДАНИЯ

| Компонент | Файл | Назначение |
|-----------|------|-----------|
| PM role | `roles/pm.md` | System prompt для PM-оркестратора (sonnet) |
| Unified reviewer role | `roles/reviewer.md` | Объединённый чеклист (arch + business + security) |

### Компоненты, которые ОБНОВЛЯЮТСЯ (роли)

| Файл | Изменение |
|------|-----------|
| `roles/analyst.md` | Убрать создание git ветки (делает PM) |
| `roles/developer.md` | Добавить: "Напиши тесты, запусти, убедись что проходят" |

### Компоненты БЕЗ ИЗМЕНЕНИЙ

| Компонент | Почему |
|-----------|--------|
| `ClaudeCLIAdapter` | --resume уже работает, usage/cost уже возвращаются |
| `Run entity` | Без изменений |
| `Task entity` | Без изменений |
| `ReviewFindings` | Unified reviewer использует тот же VERDICT/FINDINGS/SUMMARY формат |
| `RunAbortRegistry` | Cancel работает для любых ролей |
| `CallbackClient` | Callbacks не меняются |
| `taskRoutes.js` | API не меняется |
| `roles/tester.md` | Не удаляется, просто не используется |
| `roles/cto.md` | Не удаляется, просто не используется |
| `roles/reviewer-*.md` | Не удаляются, просто не используются |

## 3. Session model: task-scoped sessions

### Текущая модель

```
sessions: (project_id, role_name) → cli_session_id
```

- Session per project + role (project-wide)
- `findOrCreate(projectId, roleName)` — upsert
- Developer уже наследует analyst session (ProcessRun строки 57-64)

### Целевая модель

```
sessions: (task_id, role_name) → cli_session_id
```

- Session per task + role (task-scoped)
- Каждая задача — изолированные сессии
- Developer resume analyst session = findOrCreate(taskId, 'implementer') + --resume с analystCliSessionId

### Миграция

```sql
ALTER TABLE sessions ADD COLUMN task_id UUID REFERENCES tasks(id) ON DELETE CASCADE;
-- Existing sessions (project-scoped) keep task_id = NULL
-- New sessions created with task_id
CREATE UNIQUE INDEX idx_sessions_task_role ON sessions(task_id, role_name) WHERE task_id IS NOT NULL AND status = 'active';
```

### Session sharing: analyst → developer

Текущий хак (ProcessRun строки 57-64):
```javascript
if (run.roleName === 'developer' && !session.cliSessionId) {
  const analystSession = await this.#sessionRepo.findByProjectAndRole(projectId, 'analyst');
  if (analystSession?.cliSessionId) {
    session.cliSessionId = analystSession.cliSessionId;
  }
}
```

Целевой подход: Analyst и Developer — одна роль `implementer` в разных фазах. Одна session row: `(taskId, 'implementer')`. Developer resume = та же session.

## 4. PM-оркестратор: детерминистический + LLM

### Ключевое решение

PM НЕ вызывает LLM для стандартных переходов. Детерминистическая логика в ManagerDecision обрабатывает 90% случаев:

| Событие | Решение | LLM? |
|---------|---------|------|
| Task created | Создать ветку, запустить analyst | ❌ |
| Analyst done (research mode) | research_done callback | ❌ |
| Analyst done (full/auto) | Запустить developer (resume session) | ❌ |
| Analyst failed | **PM LLM**: retry analyst или fail? | ✅ |
| Developer done | Запустить reviewer | ❌ |
| Developer failed | **PM LLM**: retry или fail? | ✅ |
| Reviewer PASS | Merge + complete | ❌ |
| Reviewer FAIL (actionable findings) | Запустить developer fix | ❌ |
| Reviewer FAIL + revision limit | Escalate | ❌ |
| Reviewer failed/timeout | **PM LLM**: retry или fail? | ✅ |
| Merge conflict | Escalate | ❌ |
| Неизвестная ситуация | **PM LLM**: решить | ✅ |

### PM session

PM использует --resume для накопления контекста. В промпт PM приходит ТОЛЬКО дельта (результат последнего шага), не вся история:

```
// Первый вызов PM:
"Новая задача: NF-21 Pipeline v2. Описание: ..."

// После analyst done:
"Analyst завершил. Результат: <200 chars summary>. Запусти developer."

// После developer done:
"Developer завершил. Коммиты: ... Запусти reviewer."

// После reviewer PASS:
"Reviewer PASS. Summary: ... Выполни merge и заверши задачу."
```

### Когда PM вызывается как LLM

Только для non-deterministic решений (ошибки, edge cases). PM получает полный контекст через --resume и принимает решение:

```json
{"action": "retry", "role": "analyst", "prompt": "..."}
{"action": "ask_owner", "question": "...", "context": "..."}
{"action": "fail_task", "reason": "..."}
```

## 5. Unified reviewer

### Объединённый чеклист

Один reviewer (sonnet) вместо трёх, покрывает все области:

1. **Architecture** (DDD, SOLID, dependency rule)
2. **Business** (AC coverage, бизнес-логика, edge cases)
3. **Security** (injection, access control, secrets, OWASP)

### Начинает с diff

```bash
git diff main..HEAD
```

Если diff пустой → сразу PASS. Иначе: анализ diff → углубление в файлы по необходимости.

### При re-review

--resume к той же сессии. Reviewer видит предыдущие findings и проверяет исправления.

## 6. Merge через PM

PM после reviewer PASS:
```bash
git checkout main && git pull
git merge <branch> --no-ff
git push
git branch -d <branch>
```

При merge conflict → escalation (task status → needs_escalation, callback).

## 7. Целевые затраты

```
PM:          $0.10  (sonnet, 2-3 resume calls, дельта-промпты)
implementer: $3.50  (opus, analyst+developer в одной сессии)
reviewer:    $0.40  (sonnet, один вместо трёх, начинает с diff)
merge:       $0.00  (bash, не LLM)
─────────────────────
ИТОГО:       ~$4.00  (vs $7-8 текущих)
Revision:    +$1.00  (developer resume + reviewer resume)
─────────────────────
С ревизией:  ~$5.00
```

Экономия: **~40-50%** (от $7-8 до $4-5).

## 8. Риски и митигации

| Риск | Вероятность | Impact | Митигация |
|------|-----------|--------|-----------|
| PM session compaction | Средняя | Низкий | Sonnet 200K окно, типичная задача ~30K. PM получает дельты |
| Implementer session compaction | Средняя | Средний | Opus 200K. При compaction context.md как fallback |
| Unified reviewer пропускает что ловили 3 отдельных | Средняя | Средний | Объединённый чеклист. Sonnet достаточно мощный |
| Миграция sessions ломает существующие | Низкая | Высокий | task_id nullable, новый unique index WHERE task_id IS NOT NULL |
| PM делает merge неправильно | Низкая | Высокий | PM имеет Bash tool. При conflict → escalation, не auto-resolve |
| Backward compat ломается | Средняя | Высокий | API не меняется. Callbacks те же. Session migration backward compat |
