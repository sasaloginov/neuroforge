# Business Review — Sprint 4: Claude CLI Adapter + Callback Client

**Reviewer:** Аркадий (business)
**Date:** 2026-03-21
**Verdict:** APPROVED

---

## Acceptance Criteria Check

### ClaudeCLIAdapter

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | Реализует порт IChatEngine | PASS | `extends IChatEngine`, метод `runPrompt` с правильной сигнатурой |
| 2 | `runPrompt(roleName, prompt, options)` — spawn `claude -p` | PASS | Spawn вызывается с `--print` флагом, prompt передается через stdin |
| 3 | Role из RoleRegistry -> CLI-флаги: `--model`, `--system-prompt`, `--allowed-tools`, `--output-format json` | PASS | Все флаги корректно маппятся. Пустые `systemPrompt` и `allowedTools` пропускаются (тест `skips --system-prompt and --allowed-tools when empty`) |
| 4 | `--session-id` для продолжения сессии | PASS | Добавляет `--session-id` + `--resume` при наличии `sessionId` в options |
| 5 | Timeout: soft SIGTERM -> hard SIGKILL | PASS | Soft timeout по `effectiveTimeout`, hard SIGKILL через `killDelayMs` (default 5s). Тест подтверждает оба сигнала |
| 6 | AbortSignal support | PASS | Поддержка отмены через `signal.addEventListener('abort')`. Немедленный reject при `signal.aborted`. Оба кейса покрыты тестами |
| 7 | Возвращает `{ response, sessionId }` | PASS | Парсит JSON-ответ CLI, извлекает `result` и `session_id` |
| 8 | child_process.spawn с массивом аргументов | PASS | Аргументы передаются как массив. Тест `uses spawn without shell option` проверяет отсутствие `shell: true` |
| 9 | Адаптирован из mybot ClaudeCLIAdapter | N/A | Структурно соответствует паттерну, проверка происхождения не входит в business review |

### CallbackClient

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | Реализует порт ICallbackSender | PASS | `extends ICallbackSender`, метод `send` с правильной сигнатурой |
| 2 | `send(callbackUrl, payload, callbackMeta)` — HTTP POST | PASS | Использует `fetch` с `method: 'POST'`, `Content-Type: application/json` |
| 3 | Payload: `{ type, taskId, ...data, callbackMeta }` | PASS | Spread payload + callbackMeta. Без callbackMeta отправляет только payload (тест подтверждает) |
| 4 | Retry: 3 попытки с exponential backoff | PASS | По умолчанию 3 попытки. Backoff: 1s, 2s, 4s. Ретрай и на network error, и на non-ok HTTP status |
| 5 | Timeout на запрос (10s) | PASS | Default `timeoutMs: 10000`, реализован через `AbortController` + `setTimeout` |
| 6 | Не бросает исключение при ошибке callback | PASS | Возвращает `{ ok: false, ... }` вместо throw. Тест `does not throw on callback failure` подтверждает |

### Тесты

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | ClaudeCLIAdapter: unit-тест с mock child_process | PASS | 13 тестов, `vi.mock('node:child_process')`, реальный claude не вызывается |
| 2 | CallbackClient: unit-тест с mock fetch | PASS | 8 тестов, `globalThis.fetch = vi.fn()` |
| 3 | `npm test` — все тесты зеленые | PASS | 185 passed, 0 failed |

### Definition of Done

| # | Criterion | Status |
|---|-----------|--------|
| 1 | ClaudeCLIAdapter реализует IChatEngine | PASS |
| 2 | CallbackClient реализует ICallbackSender | PASS |
| 3 | Тесты проходят | PASS |
| 4 | Безопасность: spawn с массивом аргументов, нет template literals | PASS |

---

## Business Logic Assessment

### ClaudeCLIAdapter

**Корректность:** Реализация полностью соответствует бизнес-требованиям. Адаптер правильно оркестрирует вызов Claude CLI:
- Роль разрешается через RoleRegistry (domain service), конфигурация маппится в CLI-аргументы.
- Сессии поддерживаются через `--session-id` / `--resume`, что обеспечивает continuity диалога между run-ами.
- JSON-парсинг ответа с fallback на raw text повышает robustness.

**Обработка ошибок:** Адекватная. Покрыты: timeout, abort, non-zero exit, is_error в JSON, пустой ответ, ошибка spawn, неизвестная роль. Функция `finish` гарантирует однократное завершение promise.

**Замечание (minor):** Переменная `effectiveTimeout` при `timeoutMs=0` и `role.timeoutMs=0` будет `0`, что создаст мгновенный timeout. Маловероятный edge case, не блокирует.

### CallbackClient

**Корректность:** Полностью соответствует бизнес-требованиям. Callback-клиент надежно доставляет уведомления клиентам с retry-логикой и exponential backoff.

**Ключевое бизнес-свойство:** Callback failure не ломает пайплайн. Метод `send` никогда не бросает исключение, возвращает `{ ok: false }`. Это критически важно для stability оркестратора.

**Observability:** Логирование на каждом этапе (success, retry, failure) обеспечивает диагностику проблем с webhook-ами клиентов.

---

## Verdict

**APPROVED.** Все acceptance criteria выполнены. Бизнес-логика корректна, тесты покрывают основные и edge-case сценарии. Реализация готова к интеграции в pipeline оркестратора.
