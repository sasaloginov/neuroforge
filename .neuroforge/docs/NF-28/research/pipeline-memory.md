# Research: Pipeline Memory Integration

## Суть задачи

Подключить MCP-инструменты командной памяти бота (`memory_save_pipeline`, `memory_search_pipeline`) к пайплайну агентов Нейроцеха. Агенты должны:
- Читать командную память проекта перед началом работы
- Сохранять ключевые решения, отклонённые подходы, паттерны

## Текущая архитектура MCP

### Как MCP подключается к агентам сейчас

1. **`src/index.js`** (строки 115-131): создаёт единый `mcp-config.json` в `/tmp/neuroforge-mcp-<random>/`
2. Содержит один сервер `neuroforge` (SSE, порт 3100) с 3 инструментами: `report_progress`, `ask_question`, `complete`
3. Путь к конфигу передаётся в `ClaudeCLIAdapter` через конструктор (`mcpConfigPath`)
4. `ClaudeCLIAdapter.#execCLI()` добавляет `--mcp-config <path>` только при наличии `runId` и `taskId`

### Как projectId попадает в контекст агента

- `ProcessRun.execute()` → резолвит `task.projectId` → `project` через `projectRepo`
- projectId НЕ передаётся в промпт или system prompt агента — используется только для session management и gitOps
- `effectiveWorkDir` резолвится из `project.workDir` и передаётся через `options.workDir`
- `--append-system-prompt "Project workspace: <workDir>"` — единственная информация о проекте в контексте агента

### Контроль доступа к MCP-инструментам

- `allowed_tools` в frontmatter ролей передаётся как `--allowed-tools tool1,tool2,...`
- MCP-инструменты в Claude CLI именуются `mcp__<server>__<tool>`
- Сейчас MCP-инструменты НЕ упомянуты в `allowed_tools` ролей — они работают через fallback (все MCP-инструменты доступны если не заблокированы)

## Внешняя зависимость: bot-memory MCP server

- URL: `http://127.0.0.1:3099` (SSE transport)
- Предоставляет инструменты:
  - `memory_search_pipeline(projectId, query)` — поиск в командной памяти проекта
  - `memory_save_pipeline(projectId, content, tags?)` — сохранение в командную память
- Аутентификация: не указана в ТЗ (вероятно, Bearer token или без авторизации для localhost)
- Зависимость: BOT-30 в проекте mybot

## Затрагиваемые файлы

| Файл | Что менять |
|------|-----------|
| `src/index.js` | Добавить bot-memory сервер в mcp-config.json |
| `src/infrastructure/claude/claudeCLIAdapter.js` | Передавать projectId через append-system-prompt |
| `src/application/ProcessRun.js` | Передавать projectId в options chatEngine.runPrompt() |
| `.neuroforge/roles/analyst.md` | Добавить инструкции по работе с памятью + allowed_tools |
| `.neuroforge/roles/developer.md` | Добавить инструкции по работе с памятью + allowed_tools |
| `.neuroforge/roles/reviewer.md` | Добавить инструкции по чтению памяти (read-only) + allowed_tools |

## Риски

1. **bot-memory сервер недоступен** — агент получит ошибку MCP. Не блокирует работу (MCP-инструменты optional), но нужен graceful fallback в промптах
2. **Дублирование записей** — агенты могут сохранять одно и то же. Митигация: инструкции в prompt + дедупликация на стороне bot-memory
3. **Токены** — чтение/запись памяти расходует контекст. Митигация: инструкция "читай память один раз в начале, пиши только ключевые решения"
4. **Конфликт allowed_tools** — нужно добавить MCP-инструменты в allowed_tools, иначе они будут недоступны при наличии ограничения

## Архитектурные решения

### ADR-1: Единый mcp-config.json vs раздельные

**Решение:** Добавить bot-memory в тот же `mcp-config.json`, что создаётся в `src/index.js`.

**Обоснование:**
- Claude CLI принимает один `--mcp-config` файл
- Уже есть паттерн единого конфига для neuroforge-сервера
- Проще в управлении

**Альтернатива:** Создавать конфиг динамически per-project — overengineering для текущих требований.

### ADR-2: Передача projectId через append-system-prompt

**Решение:** Расширить `--append-system-prompt` в `ClaudeCLIAdapter`, добавив `ProjectId: <id>`.

**Обоснование:**
- Минимальные изменения: projectId нужно только передать через options
- Агент видит projectId и может использовать его в MCP-вызовах
- Не требует изменения сигнатуры MCP-инструментов

### ADR-3: Условное подключение bot-memory

**Решение:** Подключать bot-memory только если задана env-переменная `BOT_MEMORY_URL`.

**Обоснование:**
- Не все инсталляции Нейроцеха имеют bot-memory сервер
- Graceful degradation: без переменной — память не подключается, агенты работают как раньше
- Аналогично паттерну `MCP_PORT` для neuroforge-сервера
