# Task Context

## Затрагиваемые файлы

### Роли (системные промпты) — замена `docs/analyst/` → `.neuroforge/docs/`

| Файл | Назначение | Что менять |
|------|-----------|-----------|
| `roles/analyst.md` | Системный промпт аналитика | Строки 49-72: все пути `docs/analyst/<shortId>/` → `.neuroforge/docs/<shortId>/` |
| `roles/developer.md` | Системный промпт разработчика | Строки 20-36: пути к артефактам + pre-check |
| `roles/reviewer.md` | Системный промпт ревьюера | Строка 21: путь к context.md |

### Application layer

| Файл | Назначение | Что менять |
|------|-----------|-----------|
| `src/application/ReviseAnalysis.js` | Перезапуск аналитика с замечаниями | Строка 74: `docs/analyst/${shortId}` → `.neuroforge/docs/${shortId}` |

### Скрипты

| Файл | Назначение | Что менять |
|------|-----------|-----------|
| `scripts/onboard.js` | Создание `.neuroforge/` при онбординге | Функция `scaffoldStructure()` (строка 172): добавить `mkdirSync(resolve(neuroforgeDir, 'docs'), { recursive: true })` |

### Документация

| Файл | Назначение | Что менять |
|------|-----------|-----------|
| `CLAUDE.md` | Конвенции проекта | Строки 64, 91-93: пути артефактов. Секция Project Structure: добавить `.neuroforge/` |

### Per-project роли (внешние проекты)

| Файл | Назначение |
|------|-----------|
| `/root/dev/flower_shop/.neuroforge/roles/analyst.md` | Кастомный analyst для flower_shop — проверить пути |
| `/root/dev/flower_shop/.neuroforge/roles/developer.md` | Кастомный developer для flower_shop — проверить пути |

### Новые файлы (создать)

| Файл | Назначение |
|------|-----------|
| `/root/dev/neuroforge/.neuroforge/config.json` | Метаданные проекта neuroforge |
| `/root/dev/neuroforge/.neuroforge/docs/` | Папка для будущих артефактов задач |
| `/root/bot/mybot/.neuroforge/config.json` | Метаданные проекта mybot |
| `/root/bot/mybot/.neuroforge/docs/` | Папка для будущих артефактов задач |
| `/root/dev/flower_shop/.neuroforge/config.json` | Метаданные проекта flower_shop |
| `/root/dev/flower_shop/.neuroforge/docs/` | Папка для будущих артефактов задач |

## Ключевые сигнатуры

### ReviseAnalysis (src/application/ReviseAnalysis.js)
```javascript
constructor({ taskService, runService, runRepo, taskRepo, projectRepo, roleRegistry, callbackSender, logger })
async execute({ taskId, remarks }) → { taskId, shortId, status }
// shortId формируется: `${project.prefix}-${task.seqNumber}` (строка 63-65)
```

### scaffoldStructure (scripts/onboard.js:172)
```javascript
function scaffoldStructure(workDir, projectMeta) {
  // workDir: абсолютный путь к проекту
  // Создаёт .neuroforge/, пишет project.json, копирует checklist
}
```

### loadRoles (src/infrastructure/roles/fileRoleLoader.js)
```javascript
async function loadRoles(rolesDir) → Role[]
// НЕ МЕНЯТЬ — rolesDir продолжает указывать на roles/
```

## Зависимости

- `ReviseAnalysis` → `taskService`, `runService`, `projectRepo` (для shortId)
- `onboard.js` → `ProjectRegistrar`, `scaffoldStructure()`
- Роли загружаются `fileRoleLoader` → `RoleRegistry` → `ProjectAwareRoleResolver`
- `ProjectAwareRoleResolver.resolve()` ищет `.neuroforge/roles/` — это НЕ меняется

## Текущее поведение

1. Аналитик создаёт артефакты в `docs/analyst/<shortId>/` (путь зашит в roles/analyst.md)
2. Developer читает `docs/analyst/<shortId>/context.md` и `design/spec.md` (путь в roles/developer.md)
3. Reviewer читает `docs/analyst/<shortId>/context.md` (путь в roles/reviewer.md)
4. ReviseAnalysis.js подставляет `docs/analyst/${shortId}/` в промпт
5. onboard.js создаёт `.neuroforge/` с project.json и checklist, **без** `docs/` и `config.json`

Нужно: заменить все `docs/analyst/` на `.neuroforge/docs/` в промптах и документации, добавить `docs/` и `config.json` в scaffold.
