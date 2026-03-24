# Task Context — Pipeline v2

## Затрагиваемые файлы

### Application Layer (основные изменения)

**`src/application/ManagerDecision.js`** — центральный файл рефакторинга (620 строк)
- `execute({completedRunId})` — entry point, вызывается Worker после каждого run
- `#handleResearchMode()` — research mode auto-complete (сохраняется)
- `#handleDevFixComplete()` — re-review после dev fix (переписать)
- `#handleReviewFindings()` — review severity routing (переписать → unified reviewer)
- `buildManagerPrompt()` — промпт для manager LLM (заменить на `buildPmDeltaPrompt()`)
- `parseManagerDecision()` — парсинг JSON ответа (сохраняется для PM LLM fallback)
- `buildFixPrompt()`, `buildReReviewPrompt()` — промпты для revision (сохраняются)
- `REVIEWER_ROLES = ['reviewer-architecture', 'reviewer-business', 'reviewer-security']` — заменить на `['reviewer']`
- Exported: `{ buildManagerPrompt, parseManagerDecision, buildFixPrompt, buildReReviewPrompt }`

**`src/application/ProcessRun.js`** — выполнение run'а (147 строк)
- `execute()` — takeNext → session → gitOps → chatEngine.runPrompt → complete
- Строки 53-64: session lookup + developer-inherits-analyst хак → переписать на `findOrCreateForTask(taskId, roleName)`
- `this.#sessionRepo.findOrCreate(projectId, roleName)` → `findOrCreateForTask(run.taskId, run.roleName)`

**`src/application/CreateTask.js`** — создание задачи (103 строки)
- Строка 82-91: enqueue analyst → заменить на enqueue implementer(stepId=analyst)
- `roleName: 'analyst'` → `roleName: 'implementer'`, `stepId: 'analyst'`

**`src/application/StartNextPendingTask.js`** — активация pending задачи
- Аналогично CreateTask: enqueue implementer(analyst)

**`src/application/ReplyToQuestion.js`** — ответ на вопрос владельца
- Строка: enqueue(lastRun.roleName, prompt) — сохраняется (resume ту же роль)

**`src/application/RestartTask.js`** — перезапуск failed задачи
- Перезапуск: enqueue implementer(analyst) если нет completed runs

**`src/application/ResumeResearch.js`** — resume research_done задачи
- `roleName: 'developer'` → `roleName: 'implementer'`, `stepId: 'developer'`

### Domain Layer

**`src/domain/entities/Session.js`** — Session entity (85 строк)
- constructor: добавить `taskId` поле
- `static create()`: добавить `taskId` параметр
- `fromRow()` / `toRow()`: добавить `task_id` mapping

**`src/domain/entities/Run.js`** — Run entity
- `stepId` поле уже существует — используется для фазы (analyst/developer/fix/review)
- Без изменений в entity

**`src/domain/valueObjects/ReviewFindings.js`** — парсинг review findings
- `parse(response, reviewerRole)` — без изменений (формат VERDICT/FINDINGS/SUMMARY сохраняется)
- `parseAll(reviewerRuns)` — работает для 1 reviewer так же как для 3

**`src/domain/ports/IGitOps.js`** — Git operations порт
- Добавить `mergeBranch(branchName, workDir)` метод

### Infrastructure Layer

**`src/infrastructure/persistence/PgSessionRepo.js`** — Session persistence (86 строк)
- `findOrCreate(projectId, roleName)` — сохраняется для backward compat
- Добавить `findOrCreateForTask(taskId, roleName)` — atomic upsert по (task_id, role_name)

**`src/infrastructure/git/gitCLIAdapter.js`** — Git CLI adapter
- Добавить `mergeBranch(branchName, workDir)` — checkout main + merge + push + delete branch

**`src/index.js`** — **Критичный файл.** Composition root
- Передать `gitOps` и `workDir` в ManagerDecision

### Roles (новые/изменённые)

- `roles/implementer.md` — **НОВЫЙ**: объединённый analyst+developer system prompt (opus)
- `roles/reviewer.md` — **НОВЫЙ**: unified чеклист arch+business+security (sonnet)
- `roles/pm.md` — **НОВЫЙ**: PM для LLM fallback (sonnet)
- `roles/analyst.md` — убрать создание ветки (reference only)
- `roles/developer.md` — добавить тестирование (reference only)

## Ключевые сигнатуры

```javascript
// ManagerDecision — новые приватные методы
#routePipeline(task, completedRun, allRuns): Promise<object|null>
#afterAnalystDone(task, completedRun, allRuns): Promise<object>
#afterDeveloperDone(task, completedRun, allRuns): Promise<object>
#afterReviewerDone(task, completedRun, allRuns): Promise<object>
#mergeAndComplete(task): Promise<object>
#callPmLlm(task, completedRun, allRuns): Promise<object>

// PgSessionRepo — новый метод
findOrCreateForTask(taskId, roleName): Promise<Session>

// GitCLIAdapter — новый метод
mergeBranch(branchName, workDir): Promise<void>

// Run — существующие поля (используются для фазы)
run.roleName  // 'implementer', 'reviewer', 'pm'
run.stepId    // 'analyst', 'developer', 'fix', 'review', 'init'
```

## Зависимости

```
Worker.processOne() → ProcessRun.execute() → ManagerDecision.execute()
                           ↓                        ↓
                    PgSessionRepo          #routePipeline() → enqueue next
                    .findOrCreateForTask()  #callPmLlm() → chatEngine.runPrompt('pm')
                           ↓               #mergeAndComplete() → gitOps.mergeBranch()
                    ClaudeCLIAdapter
                    .runPrompt(--resume)
```

## Текущее поведение (что меняется)

| Аспект | v1 (текущий) | v2 (целевой) |
|--------|-------------|-------------|
| Первый run | analyst | implementer (stepId=analyst) |
| Session scope | project + role | task + role |
| Developer context | хак: наследует analyst session | нативный: та же session (implementer) |
| Reviewers | 3 параллельных (sonnet ×3) | 1 unified (sonnet) |
| Merge | CTO агент (opus LLM) | gitOps.mergeBranch() в ManagerDecision |
| Tester | Отдельный агент | Developer пишет тесты сам |
| Manager routing | LLM каждый шаг | Детерминистический + LLM fallback |
| Manager prompt | Вся история runs | Дельта (только последний результат) |
