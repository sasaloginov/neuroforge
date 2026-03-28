# Task 005: Sprint 4 — Claude CLI Adapter + Callback Client

## Тип
feature

## Приоритет
critical

## Описание
Реализовать infrastructure-адаптеры для внешних систем: ClaudeCLIAdapter (реализация IChatEngine через `claude -p`) и CallbackClient (реализация ICallbackSender через HTTP POST). После этого спринта Нейроцех может запускать Claude CLI и отправлять callback клиентам.

## Acceptance Criteria

### ClaudeCLIAdapter (`src/infrastructure/claude/claudeCLIAdapter.js`)
- [ ] Реализует порт IChatEngine
- [ ] `runPrompt(roleName, prompt, options)` — spawn `claude -p` с параметрами роли
- [ ] Получает Role из RoleRegistry → маппит в CLI-флаги: `--model`, `--system-prompt`, `--allowed-tools`, `--output-format json`
- [ ] `--session-id` для продолжения сессии (если передан sessionId)
- [ ] Timeout: soft SIGTERM → hard SIGKILL (через configurable delay)
- [ ] AbortSignal support для отмены
- [ ] Возвращает `{ response, sessionId }`
- [ ] child_process.spawn с аргументами как массив (не строка — безопасность)
- [ ] Адаптирован из mybot `ClaudeCLIAdapter`

### CallbackClient (`src/infrastructure/callback/callbackClient.js`)
- [ ] Реализует порт ICallbackSender
- [ ] `send(callbackUrl, payload, callbackMeta)` — HTTP POST
- [ ] Payload: `{ type, taskId, ...data, callbackMeta }`
- [ ] Retry: 3 попытки с exponential backoff
- [ ] Timeout на запрос (10s)
- [ ] Логирование ошибок (не бросает — callback failure не должен ломать пайплайн)

### Тесты
- [ ] ClaudeCLIAdapter: unit-тест с mock child_process (не запускает реальный claude)
- [ ] CallbackClient: unit-тест с mock fetch
- [ ] `npm test` — все тесты зелёные

## Контекст
- Зависит от: Sprint 2 (domain — IChatEngine, ICallbackSender, RoleRegistry)
- ClaudeCLIAdapter из mybot: `/root/bot/mybot/src/infrastructure/claude/ClaudeCLIAdapter.js`
- ADR #7: `--dangerously-skip-permissions` в Docker

## Затрагиваемые компоненты
- Infrastructure: claude/, callback/

## Definition of Done
- [ ] ClaudeCLIAdapter реализует IChatEngine
- [ ] CallbackClient реализует ICallbackSender
- [ ] Тесты проходят
- [ ] Безопасность: spawn с массивом аргументов, нет template literals
