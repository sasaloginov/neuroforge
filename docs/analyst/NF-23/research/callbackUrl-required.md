# Research: callbackUrl обязательность

## Проблема
`callbackUrl` — необязательное поле в `createTaskSchema`. Задачи создаются без callback, уведомления не приходят.

## Затрагиваемые файлы

### Схема валидации
- `src/infrastructure/http/routes/taskRoutes.js` — строка 9: `required: ['projectId', 'title']`
- `callbackUrl` уже описан в properties (строка 14): `{ type: 'string', format: 'uri', maxLength: 512 }`
- `callbackMeta` (строка 15) — остаётся необязательным

### Тесты
1. **`taskRoutes.test.js`** — 8 тестов в `POST /tasks` блоке, из них:
   - **Сломаются** (отправляют POST /tasks без callbackUrl, ожидая не-400):
     - L93: `creates a task and returns 202` — payload без callbackUrl
     - L136: `works without callbackMeta` — payload без callbackUrl
     - L154: `accepts mode: research` — payload без callbackUrl
     - L220: `returns 404 when project not found` — ожидает 404, но получит 400
     - L256: `returns 403 when scope does not match` — ожидает 403, но получит 400
   - **Нужно обновить для корректной проверки** (передают payload без callbackUrl, ожидая 400):
     - L170: `rejects invalid mode value` — ожидает 400, но по другой причине; нужно добавить callbackUrl чтобы тестировать именно mode
   - **Останутся рабочими**:
     - L102: `passes callbackMeta` — уже передаёт callbackUrl
     - L187: `returns 400 when title is missing` — ожидает 400 (хоть и по другой причине)
     - L200: `returns 400 when projectId is invalid` — ожидает 400

2. **`taskRoutes.extra.test.js`** — сломаются:
   - L153: `POST /tasks with callbackUrl passes it to use case` — уже передаёт callbackUrl ✓
   - L175: `POST /tasks ignores additional unknown properties` — payload без callbackUrl, ожидает 202

## Риски
- **Обратная совместимость API**: клиенты, не передающие callbackUrl, получат 400. Это намеренное изменение (breaking change).
- Риск минимальный — основной клиент (TG-бот) уже передаёт callbackUrl.
