# Research: cancel задачи не останавливает активный run

## Описание бага

При вызове `POST /tasks/:id/cancel` задача переходит в статус `cancelled`, но:
1. **Running runs** остаются в статусе `running` — не обновляются в БД
2. **Процесс Claude CLI** продолжает работу — `child_process` не убивается
3. Ответ API возвращает `cancelledRuns: 0` если нет queued runs, хотя running run продолжает выполняться

## Корневая причина

### 1. CancelTask.js фильтрует только queued

```javascript
// src/application/CancelTask.js:23
const queuedRuns = runs.filter(r => r.status === 'queued');
```

Running runs полностью игнорируются.

### 2. Нет механизма остановки CLI-процесса

`ClaudeCLIAdapter` создаёт `child_process` внутри Promise, но ссылка `proc` локальна — нет внешнего реестра для доступа к процессу по `runId`.

```javascript
// claudeCLIAdapter.js:101 — proc не экспортируется
const proc = spawn('claude', args, { ... });
```

### 3. AbortSignal уже поддерживается, но не используется

`IChatEngine.runPrompt` принимает `signal: AbortSignal`, `ClaudeCLIAdapter` обрабатывает его (SIGTERM процессу), но `ProcessRun` **не передаёт signal**:

```javascript
// ProcessRun.js:87 — signal не передаётся
result = await this.#chatEngine.runPrompt(run.roleName, enrichedPrompt, {
  sessionId, timeoutMs, runId, taskId,
  // signal: ??? — отсутствует
});
```

### 4. Run entity не разрешает running → cancelled

```javascript
// Run.js:15
[STATUSES.RUNNING]: [STATUSES.DONE, STATUSES.FAILED, STATUSES.TIMEOUT, STATUSES.INTERRUPTED],
```

`cancelled` отсутствует в списке допустимых переходов из `running`.

## Затрагиваемые файлы

| Файл | Роль | Изменение |
|------|------|-----------|
| `src/domain/entities/Run.js` | Entity | Добавить `cancelled` в TRANSITIONS[running], метод `cancel()` |
| `src/domain/services/RunService.js` | Domain Service | Добавить `cancel(runId)` метод |
| `src/application/CancelTask.js` | Use Case | Обработка running runs + abort через реестр |
| `src/application/ProcessRun.js` | Use Case | Создание AbortController, регистрация, передача signal |
| **Новый:** `src/domain/services/RunAbortRegistry.js` | Domain Service | Map<runId, AbortController> — in-memory реестр |
| `src/index.js` | Composition Root | **Критичный файл.** Создание RunAbortRegistry, передача в ProcessRun и CancelTask |

## Зависимости (data flow)

```
CancelTask → RunAbortRegistry.abort(runId) → AbortController.abort()
                                                    ↓
ProcessRun → RunAbortRegistry.register(runId, ac) → signal → ClaudeCLIAdapter → proc.kill('SIGTERM')
```

## Альтернативы рассмотренные

### A. Использовать `interrupted` вместо `cancelled` для running runs
- **За:** Не нужно менять Run entity transitions
- **Против:** Семантически неверно. `interrupted` = восстановление при рестарте. `cancelled` = явное действие пользователя. Менеджер обрабатывает эти статусы по-разному.
- **Решение:** Отклонено. Добавляем `cancelled` в transitions.

### B. Хранить процессы в ClaudeCLIAdapter (Map<runId, proc>)
- **За:** Прямой доступ к процессу
- **Против:** Нарушает DDD (infrastructure знает о runId). Дублирует уже существующий механизм AbortSignal.
- **Решение:** Отклонено. Используем AbortController/Signal — уже встроено.

### C. DB-based флаг cancel_requested + polling
- **Против:** Задержка (polling interval), усложнение
- **Решение:** Отклонено. Single-process, in-memory достаточно.

## Риски

1. **Race condition:** CancelTask вызван между `takeNext()` и `chatEngine.runPrompt()` — abort до подписки на signal
   - **Митигация:** `AbortController.abort()` ставит `signal.aborted = true` синхронно — `ClaudeCLIAdapter` проверяет до spawn
2. **Процесс не умирает после SIGTERM**
   - **Митигация:** уже есть hard timeout (SIGKILL после killDelayMs) в ClaudeCLIAdapter
3. **Двойная обработка:** ProcessRun reject('Aborted') + CancelTask cancel() — race на статусе run
   - **Митигация:** ProcessRun проверяет свежий статус run из БД; CancelTask оборачивает cancel в try/catch
