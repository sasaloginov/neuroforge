# Task Context

## Затрагиваемые файлы

### `src/index.js` (Composition Root) — КРИТИЧНЫЙ ФАЙЛ
- Строки 115-131: создание mcp-config.json
- `mcpTmpDir`, `mcpConfigPath` — путь к tmp-конфигу
- Конфиг записывается через `writeFile()` с `JSON.stringify({ mcpServers: { neuroforge: {...} } })`
- Передаётся в `new ClaudeCLIAdapter({ mcpConfigPath })`

### `src/infrastructure/claude/claudeCLIAdapter.js` — КРИТИЧНЫЙ ФАЙЛ
- `constructor({ roleRegistry, workDir, logger, killDelayMs, mcpConfigPath })`
- `#execCLI(roleName, prompt, options)` — строит CLI-аргументы
  - Строка 61: `if (this.mcpConfigPath && runId && taskId)` → `--mcp-config`
  - Строка 73: `args.push('--append-system-prompt', "Project workspace: ${effectiveWorkDir}")`
  - `options`: `{ sessionId, signal, timeoutMs, runId, taskId, workDir }`

### `src/application/ProcessRun.js`
- `execute()` — основной метод
  - Строка 50: `const projectId = task ? task.projectId : run.taskId;`
  - Строки 108-115: вызов `chatEngine.runPrompt()` с options (projectId уже в scope, но НЕ передаётся)

### `.neuroforge/roles/analyst.md`
- Frontmatter: `allowed_tools: [Read, Write, Glob, Grep, Bash, WebSearch, WebFetch]`
- Body: system prompt для analyst'а

### `.neuroforge/roles/developer.md`
- Frontmatter: `allowed_tools: [Read, Glob, Grep, Bash, Write, Edit]`
- Body: system prompt для developer'а

### `.neuroforge/roles/reviewer.md`
- Frontmatter: `allowed_tools: [Read, Glob, Grep, Bash]`
- Body: system prompt для reviewer'а

## Ключевые сигнатуры

```javascript
// ClaudeCLIAdapter
async runPrompt(roleName, prompt, options = {})
// options: { sessionId, signal, timeoutMs, runId, taskId, workDir }
// НУЖНО ДОБАВИТЬ: projectId в options

// ProcessRun
async execute() // без параметров, берёт run из очереди
// projectId доступен на строке 50, передать в chatEngine.runPrompt() options
```

## Зависимости

```
src/index.js
  → создаёт mcpConfigPath
  → передаёт в ClaudeCLIAdapter({ mcpConfigPath })

ProcessRun
  → зависит от chatEngine (ClaudeCLIAdapter)
  → вызывает chatEngine.runPrompt(role, prompt, options)

ClaudeCLIAdapter
  → читает mcpConfigPath из конструктора
  → строит CLI args в #execCLI()
```

## Текущее поведение

1. `src/index.js` создаёт mcp-config.json с одним сервером `neuroforge`
2. `ProcessRun` резолвит `projectId` из task, но НЕ передаёт его в chatEngine
3. `ClaudeCLIAdapter` добавляет `--append-system-prompt "Project workspace: <dir>"` — без projectId
4. Роли НЕ имеют MCP-инструментов bot-memory в allowed_tools
5. System prompts ролей НЕ содержат инструкций по работе с памятью

**Что нужно изменить:**
- `src/index.js`: добавить bot-memory в mcpServers (условно, по env BOT_MEMORY_URL)
- `ProcessRun`: передать projectId в options chatEngine.runPrompt()
- `ClaudeCLIAdapter`: принять projectId из options, добавить в append-system-prompt
- Роли: добавить MCP-tools в allowed_tools + инструкции в system prompt
