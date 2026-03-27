# Task Context — NF-26: Per-project roles

## Затрагиваемые файлы

### Domain layer
- **`src/domain/valueObjects/Role.js`** — иммутабельный VO: `{ name, model, timeoutMs, allowedTools, systemPrompt }`. Конструктор валидирует. Не меняется.
- **`src/domain/services/RoleRegistry.js`** — Map<name, Role>. Методы: `register(role)`, `get(name)`, `has(name)`, `getAll()`. Не меняется.
- **`src/domain/ports/IRoleResolver.js`** — **НОВЫЙ**. Порт для резолюции ролей с учётом проекта.

### Infrastructure layer
- **`src/infrastructure/roles/fileRoleLoader.js`** — `loadRoles(rolesDir)` → Role[], `parseRoleFile(content, filename)` → Role. Экспортирует обе функции. Не меняется.
- **`src/infrastructure/roles/projectAwareRoleResolver.js`** — **НОВЫЙ**. Реализация IRoleResolver: проверяет `<workDir>/.neuroforge/roles/<roleName>.md`, fallback на RoleRegistry.
- **`src/infrastructure/claude/claudeCLIAdapter.js`** — **МЕНЯЕТСЯ**. Заменить `roleRegistry.get()` на `roleResolver.resolve()`. Конструктор: `{ roleRegistry, workDir, logger, killDelayMs, mcpConfigPath }`. Метод `#execCLI(roleName, prompt, options)`: строка 57 резолвит роль.

### Application layer
- **`src/application/ProcessRun.js`** — **МЕНЯЕТСЯ**. Конструктор принимает `{ ..., roleRegistry, ... }`. Строка 48: `roleRegistry.get(run.roleName)`. Строка 85: `resolveWorkDir()`. Строка 107-114: `chatEngine.runPrompt()` с `timeoutMs: role.timeoutMs`.

### Composition root
- **`src/index.js`** — **МЕНЯЕТСЯ** (критичный файл). Строки 87-93: загрузка ролей. Строка 131-135: создание ClaudeCLIAdapter. Строки 146+: инжекция в use cases.

## Ключевые сигнатуры

```js
// fileRoleLoader.js — НЕ МЕНЯЕТСЯ, реюзается
parseRoleFile(content: string, filename: string) → Role

// Role.js — конструктор
new Role({ name, model, timeoutMs, allowedTools, systemPrompt })

// RoleRegistry — НЕ МЕНЯЕТСЯ
get(name: string) → Role  // throws RoleNotFoundError
has(name: string) → boolean

// ClaudeCLIAdapter — ТЕКУЩИЙ конструктор
constructor({ roleRegistry, workDir, logger, killDelayMs, mcpConfigPath })

// ProcessRun — ТЕКУЩИЙ конструктор
constructor({ runRepo, runService, taskRepo, projectRepo, chatEngine, sessionRepo, roleRegistry, callbackSender, gitOps, workDir, runAbortRegistry, logger })
```

## Зависимости (DI)

```
src/index.js
  ├─ loadRoles(config.rolesDir) → roles[]
  ├─ RoleRegistry ← roles[]
  ├─ ClaudeCLIAdapter ← { roleRegistry, workDir, mcpConfigPath }
  └─ ProcessRun ← { ..., roleRegistry, chatEngine(=ClaudeCLIAdapter), ... }
```

## Текущее поведение

1. Сервер стартует → `loadRoles('./roles/')` → 10 глобальных ролей → `RoleRegistry`
2. Задача для flower_shop → `ProcessRun.execute()` → `roleRegistry.get('developer')` → глобальный developer (Node.js стек)
3. `ClaudeCLIAdapter.#execCLI()` → тот же глобальный developer → `--system-prompt "Node.js developer prompt"`
4. Claude работает в `/root/dev/flower_shop/` (workDir верный), но с промптом для Node.js

**Нужно**: при резолюции роли проверять `<effectiveWorkDir>/.neuroforge/roles/<roleName>.md` → если есть, использовать его.
