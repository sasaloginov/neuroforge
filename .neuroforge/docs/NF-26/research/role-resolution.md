# NF-26: Исследование — загрузка ролей per-project

## Текущее состояние

### Как загружаются роли
1. **Старт сервера** (`src/index.js:87-93`): `loadRoles(config.rolesDir)` читает все `roles/*.md`
2. Каждый файл парсится `parseRoleFile()` → YAML frontmatter + body → `Role` value object
3. Все роли регистрируются в `RoleRegistry` (in-memory Map по name)
4. `RoleRegistry` инжектится в `ClaudeCLIAdapter` и `ProcessRun`

### Где роль резолвится при выполнении run'а
1. `ProcessRun.execute()` строка 48: `roleRegistry.get(run.roleName)` → используется `role.timeoutMs`
2. `ClaudeCLIAdapter.#execCLI()` строка 57: `roleRegistry.get(roleName)` → используются `role.model`, `role.systemPrompt`, `role.allowedTools`, `role.timeoutMs`

### Проблема
`RoleRegistry` — глобальный синглтон. Для flower_shop (PHP/Vue) агент получает Node.js-промпт из `roles/developer.md` вместо `/root/dev/flower_shop/.neuroforge/roles/developer.md`.

## Проектные роли flower_shop

Директория `/root/dev/flower_shop/.neuroforge/roles/` содержит:
- `analyst.md` — PHP/Symfony-специфичный промпт
- `developer.md` — PHP 8.2, Symfony 6+, Doctrine ORM, Vue 3
- `reviewer.md` — PHP/Vue-специфичное ревью

Формат файлов идентичен глобальным: YAML frontmatter + markdown body. `parseRoleFile()` может парсить их без изменений.

## Точки интеграции

### workDir уже доступен в контексте выполнения
- `ProcessRun.execute()` строка 85: `resolveWorkDir({ project, fallback })` → `effectiveWorkDir`
- `ClaudeCLIAdapter.#execCLI()` строка 51: `effectiveWorkDir = workDir || this.workDir`
- **Проблема**: роль резолвится ДО вычисления workDir (строка 48 vs 85)

### Зависимые компоненты
| Компонент | Как использует RoleRegistry |
|-----------|---------------------------|
| `ProcessRun` | `.get(roleName)` → timeoutMs |
| `ClaudeCLIAdapter` | `.get(roleName)` → model, systemPrompt, allowedTools, timeoutMs |
| `CreateTask` | `.has(roleName)` → валидация |
| `ManagerDecision` | `.get(roleName)` → для запуска следующего run |
| `RestartTask` | `.get(roleName)` → валидация |
| `ResumeResearch` | `.get(roleName)` → валидация |
| `StartNextPendingTask` | `.has(roleName)` |
| `ManagerScheduler` | transitive через ManagerDecision |

### Какие компоненты нужно менять
Только **ProcessRun** и **ClaudeCLIAdapter** — это единственные места, где роль используется для **выполнения** (model, systemPrompt, allowedTools, timeoutMs).

Остальные use cases используют `has()`/`get()` только для **валидации** (проверка что роль существует). Глобальных ролей для валидации достаточно — если роль не существует глобально, проектная тоже не поможет.

## Риски

1. **Файл роли может быть невалидным** — parseRoleFile выбросит ошибку → run упадёт. Это приемлемо (fail fast).
2. **Роль есть в проекте, но не в глобальном реестре** — CreateTask/ManagerDecision не знают о ней. Scope задачи: override существующих ролей, не добавление новых.
3. **Производительность** — чтение файла на каждый run (~KB, ~1ms). Кеширование не нужно при текущих нагрузках.
4. **Безопасность** — проектный файл может содержать инъекцию в systemPrompt. Это by design: владелец проекта контролирует свои роли.

## ADR: Resolution strategy

**Решение**: per-project файл полностью заменяет глобальную роль (full override, не merge).

**Альтернатива**: merge frontmatter (проект переопределяет только systemPrompt, оставляя model/timeout глобальные).

**Обоснование**: full override проще, предсказуемее, и flower_shop уже определяет полные роли с frontmatter. Merge создаёт неочевидные взаимодействия.
