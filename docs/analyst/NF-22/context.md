# Task Context

## Затрагиваемые файлы

### Существующие (читать, не менять)

| Файл | Назначение |
|------|-----------|
| `src/domain/entities/Project.js` | Entity проекта. `Project.create({name, prefix, repoUrl, workDir})` — валидация prefix через `^[A-Z][A-Z0-9]{0,9}$` |
| `src/domain/entities/User.js` | Entity пользователя. `User.create({name, role})` |
| `src/domain/entities/ApiKey.js` | Entity API ключа. `ApiKey.create({name, keyHash, userId, projectId, expiresAt})` |
| `src/infrastructure/persistence/PgProjectRepo.js` | Persistence. `save(project)`, `findByName(name)`, `findByPrefix(prefix)` |
| `src/infrastructure/persistence/PgUserRepo.js` | Persistence. `save(user)` |
| `src/infrastructure/persistence/PgApiKeyRepo.js` | Persistence. `save(apiKey)` |
| `src/infrastructure/persistence/pg.js` | Pool creation. `createPool(databaseUrl)` → pg Pool |

### Новые файлы (создать)

| Файл | Назначение |
|------|-----------|
| `scripts/onboard.js` | CLI entry point. Парсинг аргументов, интерактивный wizard, orchestration |
| `scripts/lib/projectRegistrar.js` | Регистрация в БД: project + user + apiKey. Возвращает raw token |
| `scripts/lib/claudeMdGenerator.js` | Генерация CLAUDE.md из шаблона + DetectedStack |
| `scripts/lib/permissionsGenerator.js` | Генерация .claude/settings.local.json по стеку |
| `src/domain/services/StackDetector.js` | Обнаружение стека по файлам (package.json, composer.json...) |
| `src/domain/valueObjects/DetectedStack.js` | Value object: primaryLanguage, frameworks, testFramework и т.д. |

## Ключевые сигнатуры

```js
// Project.create — использовать для создания entity
Project.create({ name, prefix, repoUrl, workDir }) → Project

// User.create
User.create({ name, role }) → User  // role: 'admin' | 'member'

// ApiKey.create
ApiKey.create({ name, keyHash, userId, projectId, expiresAt }) → ApiKey

// pg.js — получение пула
import { createPool } from '../src/infrastructure/persistence/pg.js';
const pool = createPool(process.env.DATABASE_URL);

// PgProjectRepo
constructor(pool)
save(project) → void
findByName(name) → Project | null

// PgUserRepo
constructor(pool)
save(user) → void

// PgApiKeyRepo
constructor(pool)
save(apiKey) → void
```

## Зависимости

```
scripts/onboard.js
  ├── scripts/lib/projectRegistrar.js
  │     ├── src/domain/entities/Project.js
  │     ├── src/domain/entities/User.js
  │     ├── src/domain/entities/ApiKey.js
  │     ├── src/infrastructure/persistence/PgProjectRepo.js
  │     ├── src/infrastructure/persistence/PgUserRepo.js
  │     └── src/infrastructure/persistence/PgApiKeyRepo.js
  ├── scripts/lib/claudeMdGenerator.js
  │     └── src/domain/valueObjects/DetectedStack.js
  ├── scripts/lib/permissionsGenerator.js
  │     └── src/domain/valueObjects/DetectedStack.js
  └── src/domain/services/StackDetector.js
        └── src/domain/valueObjects/DetectedStack.js
```

DB pool создаётся в скрипте через `createPool(DATABASE_URL)` из `pg.js`.

## Текущее поведение

Сейчас добавление проекта — 3+ отдельных HTTP-запроса (POST /projects, POST /admin/users, POST /admin/api-keys) + ручное создание CLAUDE.md. Нет автоматического определения стека, нет генерации permissions. Каждый шаг требует UUID предыдущего.

**Что нужно изменить:** Создать единый CLI-скрипт, который делает всё за один вызов: detect stack → register in DB → generate CLAUDE.md + permissions → выдать API key.

**Что НЕ нужно менять:** Существующие entities, repos, API endpoints — они остаются как есть. Скрипт переиспользует их напрямую.
