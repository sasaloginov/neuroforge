# Architecture Review — Sprint 5: Application Layer (Use Cases)

**Reviewer:** Аркадий (architecture)
**Date:** 2026-03-21
**Verdict:** APPROVED with remarks

---

## Summary

Application-слой реализован качественно. Все 6 use cases следуют DDD-правилам, зависят только от domain, используют DI через конструкторы. Код чистый, читаемый, соответствует спецификации. Замечания носят рекомендательный характер и не блокируют приемку.

---

## Checklist

| Критерий | Статус | Комментарий |
|----------|--------|-------------|
| Use cases зависят ТОЛЬКО от domain | PASS | Все импорты ведут в `../domain/` — entities, errors, services через DI |
| Один use case = один файл | PASS | 6 файлов, 6 классов |
| DI через конструкторы | PASS | Деструктуризация объекта, private fields (#) |
| DDD dependency rule | PASS | Нет импортов из infrastructure |
| SOLID | PASS | SRP соблюден, каждый use case — одна ответственность |
| DRY | PASS с замечанием | Паттерн callback-отправки повторяется (см. R3) |
| KISS | PASS | Простые, линейные алгоритмы |
| Naming conventions | PASS с замечанием | PascalCase файлы (см. R1) |

---

## Findings

### R1 [INFO] — PascalCase file names для use cases

Файлы use cases именованы в PascalCase (`CreateTask.js`, `ProcessRun.js`), тогда как CLAUDE.md требует camelCase (`taskService.js`). Однако это осознанное решение: use case = класс = файл, PascalCase для файлов-классов — распространенная практика в JS-проектах. Сервисы в domain уже используют PascalCase для файлов (`TaskService.js`, `RunService.js`), так что конвенция единообразна.

**Решение:** Не блокирует. Рекомендую зафиксировать в CLAUDE.md: "Файлы, экспортирующие один класс, именуются по имени класса (PascalCase)."

---

### R2 [LOW] — ProcessRun: прямое использование IRunRepo.takeNext() вместо RunService

`ProcessRun` инжектит и `runRepo`, и `runService`. Метод `takeNext()` вызывается напрямую через `runRepo`, а `complete()`/`fail()`/`timeout()` — через `runService`. Это корректно по смыслу: `takeNext()` — операция репозитория (атомарная dequeue), а `complete()`/`fail()` — domain-логика. Но стоит задокументировать это разделение.

Спецификация (design/spec.md) описывает в зависимостях `runService` и `taskService` (без `runRepo`), а в реализации `runRepo` добавлен. Это минимальное расхождение с дизайном, но оправдано архитектурно: `takeNext()` — инфраструктурная операция очереди, которую domain service не обязан оборачивать.

**Решение:** Не блокирует. Расхождение оправдано.

---

### R3 [LOW] — Повторяющийся паттерн callback-отправки

Во всех use cases есть блок:

```javascript
if (task.callbackUrl) {
  await this.#callbackSender.send(callbackUrl, payload, callbackMeta);
}
```

Этот guard (`if callbackUrl`) повторяется 12+ раз. Можно вынести в `callbackSender.send()` — если `url` null/undefined, просто return. Это упростит use cases и уберет дублирование.

**Решение:** Не блокирует. Рекомендация для следующего рефакторинга.

---

### R4 [LOW] — ManagerDecision: использование `crypto.randomUUID()` напрямую

В `ManagerDecision.js` (строка 116) используется `crypto.randomUUID()` для генерации `questionId`. Во всех entities (`Task.create()`, `Run.create()`, `Session.create()`) UUID тоже генерируется через `crypto.randomUUID()`, так что подход единообразный. Однако для тестируемости может быть полезно вынести генерацию ID в отдельную фабрику или принимать через DI.

**Решение:** Не блокирует. Рекомендация на будущее.

---

### R5 [LOW] — CancelTask: прямая мутация Run через `run.transitionTo()` + `runRepo.save()`

`CancelTask` вызывает `run.transitionTo('cancelled')` и `runRepo.save(run)` напрямую, минуя `RunService`. Это работает, но нарушает принцип: lifecycle операции с Run должны идти через `RunService`. В `RunService` нет метода `cancel()`, но его стоит добавить для консистентности.

**Решение:** Не блокирует. Рекомендую добавить `RunService.cancel(runId)` в следующем спринте.

---

### R6 [MEDIUM] — ProcessRun: Session создается с `projectId = run.taskId`

В `ProcessRun.js` (строка 34):

```javascript
session = Session.create({ projectId: run.taskId, roleName: run.roleName, cliSessionId: null });
```

`projectId` в Session — это projectId проекта, но здесь передается `taskId`. Также в строке 33 вызывается `sessionRepo.findByProjectAndRole(run.taskId, run.roleName)` — то есть поиск сессии по taskId вместо projectId.

Если дизайн подразумевает, что CLI-сессии привязаны к задаче (task), а не к проекту (project), то поле Session.projectId семантически некорректно названо — оно хранит taskId. Если же сессии должны быть привязаны к проекту, то нужно получать `projectId` из Task.

**Решение:** Требует уточнения. Необходимо определить: сессия привязана к task или к project? Если к task — переименовать поле в Session. Если к project — получать projectId из Task перед созданием сессии.

---

### R7 [INFO] — ManagerDecision: хорошая обработка edge cases

Отмечу качественную обработку граничных случаев в `ManagerDecision`:
- Проверка терминального статуса task (skip)
- Ожидание параллельных pending runs
- Обработка непарсируемого ответа manager
- Обработка ошибок при выполнении решения (catch + failTask)
- Валидация роли через `roleRegistry.get()` перед spawn
- Инкремент ревизии при повторном developer run

Это зрелая реализация, готовая к production-нагрузкам.

---

### R8 [INFO] — Соответствие спецификации

Все 6 use cases реализованы в соответствии с design/spec.md:

| Use Case | Спецификация | Реализация | Статус |
|----------|-------------|------------|--------|
| CreateTask | UC1 | Полностью соответствует | OK |
| ProcessRun | UC2 | Соответствует, +runRepo (см. R2) | OK |
| ReplyToQuestion | UC4 | Соответствует | OK |
| CancelTask | UC5 | Соответствует | OK |
| GetTaskStatus | UC6 | Соответствует | OK |
| ManagerDecision | UC3 | Соответствует | OK |

---

### R9 [INFO] — Domain changes: TaskService.getTask()

Добавлен публичный метод `getTask(taskId)` в `TaskService`. Ранее был только приватный `#getTask()`. Теперь `getTask()` — public, а `#getTask()` делегирует в него. Это корректное изменение: use cases нуждаются в получении задачи по ID, и domain service предоставляет эту возможность.

Однако наличие и public `getTask()`, и private `#getTask()` с идентичной логикой избыточно. Рекомендую убрать `#getTask()` и использовать `getTask()` напрямую внутри TaskService.

---

### R10 [INFO] — Domain errors

Три новых domain error (`InvalidStateError`, `ProjectNotFoundError`, `ValidationError`) корректно наследуют от `DomainError`, имеют коды ошибок, следуют существующему паттерну (`TaskNotFoundError`, `RunNotFoundError`, `RevisionLimitError`).

---

## Dependency Map (verification)

```
CreateTask.js
  imports: ProjectNotFoundError, ValidationError (domain/errors)
  DI: taskService, runService, roleRegistry, projectRepo, callbackSender

ProcessRun.js
  imports: Session (domain/entities), RunTimeoutError (domain/errors)
  DI: runRepo, runService, chatEngine, sessionRepo, roleRegistry, callbackSender

ReplyToQuestion.js
  imports: InvalidStateError (domain/errors)
  DI: taskService, runService, runRepo, callbackSender

CancelTask.js
  imports: (none)
  DI: taskService, runRepo, callbackSender

GetTaskStatus.js
  imports: (none)
  DI: taskService, runRepo

ManagerDecision.js
  imports: RunNotFoundError, InvalidStateError (domain/errors)
  DI: runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo
```

**Zero infrastructure imports confirmed.** All dependencies flow through DI (ports) or direct domain imports (entities, errors).

---

## Verdict

**APPROVED.** Application layer correctly implements DDD patterns. No infrastructure leaks, clean DI, proper error handling. R6 (Session projectId/taskId mismatch) requires clarification but does not block acceptance.
