# Research: test callbackMeta

## Что такое callbackMeta

`callbackMeta` — opaque JSONB-объект, который клиент передаёт при создании задачи. Система прозрачно прокидывает его через все слои и возвращает в каждом callback-уведомлении. Типичное использование — `{ chatId: 123 }` для Telegram-бота.

## Поток данных callbackMeta

```
HTTP POST /tasks { callbackMeta: {...} }
  → CreateTask → Task.create(callbackMeta) → PgTaskRepo.save (JSONB)
  → RunService.enqueue(callbackMeta) → Run.create(callbackMeta) → PgRunRepo.save (JSONB)
  → CallbackClient.send(url, payload, callbackMeta) → HTTP POST { ...payload, callbackMeta }
```

## Затрагиваемые файлы

### Domain
| Файл | Роль callbackMeta | Тесты |
|---|---|---|
| `src/domain/entities/Task.js` | Хранит в поле `callbackMeta` | ✅ roundtrip toRow/fromRow |
| `src/domain/entities/Run.js` | Хранит в поле `callbackMeta` | ⚠️ roundtrip НЕ проверяет callbackMeta |
| `src/domain/services/TaskService.js` | Прокидывает в Task.create | ❌ нет теста |
| `src/domain/services/RunService.js` | Прокидывает в Run.create | ❌ нет теста |

### Application
| Файл | Роль callbackMeta | Тесты |
|---|---|---|
| `src/application/CreateTask.js` | Передаёт в taskService, runService, callbackSender | ✅ 3 кейса (active, pending, backlog) |
| `src/application/ProcessRun.js` | Берёт из run, передаёт в callbackSender | ✅ success, timeout, error |
| `src/application/ManagerDecision.js` | Берёт из task, передаёт в callbackSender и runService | ✅ spawn_run, ask_owner, complete_task, fail_task |
| `src/application/CancelTask.js` | Берёт из task, передаёт в callbackSender | ✅ проверяет 3й аргумент send |
| `src/application/RestartTask.js` | Берёт из task, передаёт в callbackSender и runService | ✅ проверяет 3й аргумент send |
| `src/application/StartNextPendingTask.js` | Берёт из task, передаёт в runService.enqueue | ✅ проверяет callbackMeta в enqueue |
| `src/application/EnqueueTask.js` | Не работает с callbackMeta напрямую | N/A |

### Infrastructure
| Файл | Роль callbackMeta | Тесты |
|---|---|---|
| `src/infrastructure/callback/callbackClient.js` | Добавляет в payload если не null | ✅ с meta и без meta |
| `src/infrastructure/persistence/PgTaskRepo.js` | JSON.stringify при save, parse при read | ✅ integration: saveWithSeqNumber + findById |
| `src/infrastructure/persistence/PgRunRepo.js` | JSON.stringify при save, parse при read | ❌ integration: НЕ проверяет callbackMeta |
| `src/infrastructure/http/routes/taskRoutes.js` | Принимает в body, передаёт в use case | ❌ НЕ проверяет проброс callbackMeta |

## Выявленные пробелы тестового покрытия

### Критические (нет тестов)
1. **PgRunRepo** — callbackMeta не проверяется при сохранении/чтении. Run создаётся без callbackMeta в тестах.
2. **taskRoutes HTTP** — нет теста что callbackMeta из body POST /tasks попадает в execute().
3. **RunService** — нет юнит-теста что callbackMeta пробрасывается в Run.create().
4. **TaskService** — нет юнит-теста что callbackMeta пробрасывается в Task.create().

### Незначительные
5. **Run entity** — roundtrip тест не проверяет сохранение callbackMeta.
6. **ManagerDecision spawn_runs** — нет явного теста что callbackMeta прокидывается в каждый run при batch-запуске.

## Риски

- **Минимальные**: callbackMeta — простой pass-through, логика тривиальная (spread в payload).
- Основной риск — регрессия при рефакторинге: если кто-то забудет прокинуть callbackMeta в новом use case, без тестов это не заметят.
- PgRunRepo — если callbackMeta теряется при записи/чтении Run, все callback-ы из ProcessRun будут без meta.

## Зависимости

Нет внешних зависимостей. Все пробелы закрываются unit-тестами (моки) и дополнением существующих integration-тестов.
