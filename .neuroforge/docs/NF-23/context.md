# Task Context

## Затрагиваемые файлы

### `src/infrastructure/http/routes/taskRoutes.js`
Fastify route-плагин. Экспортирует `taskRoutes({ useCases })`.
- `createTaskSchema` (L6-32) — JSON Schema для `POST /tasks`. Свойство `required` на L9.
- `callbackUrl` уже описан в `properties` (L14): `{ type: 'string', format: 'uri', maxLength: 512 }`
- `callbackMeta` (L15): `{ type: 'object' }` — остаётся необязательным.

### `src/infrastructure/http/routes/taskRoutes.test.js`
Основные тесты для taskRoutes. 503 строки.
- `buildUseCases()` (L14) — фабрика моков use cases
- `setup()` (L64) — создаёт тестовый сервер
- `POST /tasks` блок (L82-261) — 9 тестов, 6 из них сломаются
- Используют `authHeader()` из `../testHelper.js`

### `src/infrastructure/http/routes/taskRoutes.extra.test.js`
Доп. покрытие. 278 строк.
- Свой `buildUseCases()` и `setup()` (L12-48)
- L175: тест `ignores additional unknown properties` — сломается

## Ключевые сигнатуры
- `createTestServer({ registerRoutes })` — из `testHelper.js`, создаёт Fastify instance
- `authHeader()` — возвращает `{ authorization: 'Bearer test-token-123' }`
- `app.inject({ method, url, headers, payload })` — Fastify light injection для тестов

## Зависимости
Fastify валидирует body по JSON Schema ДО вызова handler'а. Если `required` поле отсутствует → автоматически 400.

## Текущее поведение
`POST /tasks` принимает body без `callbackUrl` — Fastify пропускает запрос, задача создаётся, callback не настроен. Нужно: Fastify отклоняет запрос с 400 если `callbackUrl` отсутствует.
