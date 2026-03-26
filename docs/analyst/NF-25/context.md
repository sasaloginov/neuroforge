# Task Context

## Затрагиваемые файлы

### Domain
- `src/domain/entities/Task.js` — Entity с state machine. TRANSITIONS объект (строка 16-26). Нужно добавить `cancelled → [in_progress]`.
- `src/domain/valueObjects/TaskMode.js` — Enum MODES: full, research, fix, auto. Функция `isValidMode()`. Без изменений.
- `src/domain/services/TaskService.js` — `enqueueFromBacklog(taskId)` (строка 35), `updateMode(taskId, mode)` (строка 77), `restartTask(taskId)` (строка 118).

### Application
- `src/application/ResumeResearch.js` — Текущий resume. `execute({ taskId, instruction })`. Только из `research_done`. Без изменений в логике.
- `src/application/EnqueueTask.js` — `execute({ taskId })`. Вызывает `taskService.enqueueFromBacklog()` + `startNextPendingTask.execute()`. Нужно добавить `mode`.
- `src/application/RestartTask.js` — `execute({ taskId })`. Из `failed`. Использует `managerDecision.execute()`. Образец для ResumeTask.
- `src/application/ManagerDecision.js` — `execute({ completedRunId })`. Детерминистическая логика маршрутизации. Используется в RestartTask и будет в ResumeTask.

### Infrastructure
- `src/infrastructure/http/routes/taskRoutes.js` — Fastify routes. Схемы: `resumeSchema` (строка 126), `enqueueSchema` (строка 35). Маршруты: `/resume` (строка 250), `/enqueue` (строка 280).
- `src/index.js` — Composition root. DI для use cases (строка 151-155), объект useCases (строка 179).

## Ключевые сигнатуры

### TaskService
- `restartTask(taskId)` — переход в IN_PROGRESS, save
- `enqueueFromBacklog(taskId)` — переход BACKLOG→PENDING, save
- `updateMode(taskId, mode)` — валидация + save

### PgTaskRepo
- `activateIfNoActive(taskId, projectId, fromStatus='pending')` — атомарный UPDATE с NOT EXISTS

### RestartTask (образец для ResumeTask)
```js
constructor({ taskService, runService, runRepo, projectRepo, roleRegistry, managerDecision, callbackSender })
execute({ taskId }) → { taskId, shortId, status, decision }
```

### EnqueueTask
```js
constructor({ taskService, startNextPendingTask, projectRepo })
execute({ taskId }) → { taskId, shortId, status }
```

## Зависимости (DI в index.js)
- `restartTask` получает: taskService, runService, runRepo, projectRepo, roleRegistry, managerDecision, callbackSender
- `enqueueTask` получает: taskService, startNextPendingTask, projectRepo
- `resumeResearch` получает: taskService, runService, runRepo, taskRepo, projectRepo, roleRegistry, callbackSender
- useCases передаётся в `taskRoutes({ useCases })`

## Текущее поведение

### /resume (ResumeResearch)
1. Проверяет status === 'research_done'
2. Требует instruction (обязательно)
3. activateIfNoActive(taskId, projectId, 'research_done')
4. updateMode → 'full'
5. Находит последний analyst run, берёт response как контекст
6. Enqueue developer с промптом

### /enqueue (EnqueueTask)
1. taskService.enqueueFromBacklog(taskId) — backlog→pending
2. startNextPendingTask.execute() — пытается активировать

### /restart (RestartTask)
1. Проверяет status === 'failed'
2. taskService.restartTask(taskId) — failed→in_progress
3. Берёт историю ранов, находит последний terminal
4. Если нет ранов → enqueue analyst
5. Если есть → managerDecision.execute({ completedRunId: lastRun.id })
