# NF-27: Текущее состояние — пути артефактов и конфигурация проектов

## 1. Где сейчас живут артефакты аналитика

### Hardcoded пути `docs/analyst/<shortId>/`

| Файл | Строки | Контекст |
|------|--------|----------|
| `roles/analyst.md` | 49-65 | Определяет рабочую папку, git-команды |
| `roles/developer.md` | 20-36 | Читает context.md, spec.md, pre-check |
| `roles/reviewer.md` | 21 | Читает context.md |
| `src/application/ReviseAnalysis.js` | 74 | Динамический промпт с `docs/analyst/${shortId}/` |
| `src/application/ManagerDecision.js` | 151 | Промпт developer'а: `spec.md`, `context.md` (без полного пути) |
| `CLAUDE.md` | 64, 91-93 | Документация конвенций |

### Существующие артефакты в neuroforge
```
docs/analyst/
├── NF-22/
├── NF-23/
├── NF-25/
└── NF-26/
```

## 2. Текущая структура `.neuroforge/` по проектам

### neuroforge (`/root/dev/neuroforge/`)
- **Нет `.neuroforge/`** вообще
- Роли в `roles/` (10 файлов) — глобальные, не per-project
- `ROLES_DIR` в `src/index.js:48` → `process.env.ROLES_DIR || '../roles'`
- Артефакты в `docs/analyst/<shortId>/`

### flower_shop (`/root/dev/flower_shop/`)
- **Есть `.neuroforge/`**:
  - `project.json` — метаданные (projectId, name, prefix FLO, repoUrl)
  - `onboarding-checklist.md`
  - `roles/` — кастомные analyst.md, developer.md, reviewer.md
- Нет `docs/` или `config.json`

### mybot (`/root/bot/mybot/`)
- **Нет `.neuroforge/`** вообще

## 3. Как загружаются роли

### Глобальные роли (`fileRoleLoader.js`)
```
loadRoles(rolesDir) → Role[]
```
- Читает все `*.md` из `rolesDir`
- Парсит YAML frontmatter → `Role({ name, model, timeoutMs, allowedTools, systemPrompt })`

### Per-project override (`projectAwareRoleResolver.js`)
```
resolve(roleName, projectWorkDir?) → Role
```
1. Если `projectWorkDir` → ищет `<workDir>/.neuroforge/roles/<roleName>.md`
2. Если найден → возвращает project-specific Role
3. Иначе → fallback на RoleRegistry (глобальный)

### DI в `src/index.js:48`
```javascript
rolesDir: process.env.ROLES_DIR || new URL('../roles', import.meta.url).pathname
```

## 4. Как строятся промпты агентов

### analyst (CreateTask.js:125)
Промпт **не содержит** путь `docs/analyst/` — путь зашит в **системном промпте** роли (roles/analyst.md).

### developer (ManagerDecision.js:145-152)
```
Реализуй задачу по спецификации из design/spec.md. Используй context.md для навигации.
```
Относительные пути — developer ищет по системному промпту роли.

### reviewer (ManagerDecision.js:183-202)
Промпт **не упоминает** docs/analyst — путь в системном промпте роли.

### ReviseAnalysis.js:74
```javascript
`Обнови артефакты в docs/analyst/${shortId ?? '<shortId>'}/`
```
**Единственное место** с hardcoded путём в коде application layer.

## 5. Риски

1. **Миграция существующих артефактов** — 4 задачи (NF-22..NF-26) имеют артефакты в `docs/analyst/`. Перенос опасен — может сломать ссылки в контексте developer'ов (session sharing).
2. **Self-referencing** — neuroforge как проект использует свои же роли. Перенос `roles/` → `.neuroforge/roles/` требует обновления `ROLES_DIR` default в `src/index.js` (критичный файл).
3. **Тесты fileRoleLoader** — тест жёстко ссылается на `../../../roles` и ожидает 10 файлов.
4. **config.json** — новая сущность, нигде не используется в коде. Нужно решить: читать его в runtime или только для агентов?
