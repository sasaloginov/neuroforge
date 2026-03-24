# Исследование: текущий процесс онбординга проектов

## Что сейчас нужно сделать вручную

### 1. Серверная сторона (Neuroforge API)

**Шаг 1: Создать проект через API**
```bash
curl -X POST http://localhost:3000/projects \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "flower-shop", "prefix": "FS", "repoUrl": "https://github.com/...", "workDir": "/root/dev/flower_shop"}'
```
Создаёт запись в таблице `projects` (id, name, prefix, repo_url, work_dir).

**Шаг 2: Создать пользователя (если нового)**
```bash
curl -X POST http://localhost:3000/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name": "flower-shop-owner", "role": "member"}'
```

**Шаг 3: Создать API-ключ с привязкой к проекту**
```bash
curl -X POST http://localhost:3000/admin/api-keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name": "flower-shop-key", "projectId": "<project-uuid>"}'
```
Возвращает `token` — единственный раз, когда он виден в открытом виде.

### 2. Клиентская сторона (репозиторий проекта)

**Шаг 4: Создать CLAUDE.md** в корне проекта — основной контекст для агентов.
Содержит: описание проекта, стек, структуру, ссылки на API.

**Шаг 5 (опционально): Настроить .claude/settings.local.json** — permissions для Bash-команд.

### 3. Что НЕ автоматизировано

| Шаг | Статус |
|-----|--------|
| Регистрация проекта в БД | API есть, но вручную |
| Создание пользователя | API есть, но вручную |
| Генерация API-ключа | API есть, но вручную |
| CLAUDE.md | Полностью вручную |
| .claude/settings.local.json | Полностью вручную |
| Валидация доступности репо | Не реализована |
| Проверка workDir | Не реализована |
| Первичный анализ стека | Не реализован |

## Данные, необходимые от пользователя

### Обязательные
| Параметр | Описание | Пример | Валидация |
|----------|----------|--------|-----------|
| `name` | Slug проекта (уникальный) | `flower-shop` | `^[a-z0-9_-]+$`, 1-128 |
| `prefix` | Префикс для shortId задач | `FS` | `^[A-Z][A-Z0-9]{0,9}$` |
| `repoUrl` | Git URL репозитория | `https://github.com/...` | URI format |
| `workDir` | Абсолютный путь к рабочей директории | `/root/dev/flower_shop` | Существующая директория |

### Опциональные (можно определить автоматически)
| Параметр | Описание | Автоопределение |
|----------|----------|-----------------|
| Стек технологий | Языки, фреймворки | Из package.json, composer.json, go.mod и т.д. |
| Структура проекта | Monorepo/single | Из наличия подпапок |
| Тестовый фреймворк | vitest, phpunit, pytest | Из конфигов |
| Описание проекта | Что делает проект | Из README.md |

## Два контекста использования

### A. Нейроцех-пайплайн (analyst → developer → reviewer)
- `workDir` используется в `ClaudeCLIAdapter` как `cwd` для claude CLI
- `workDir` используется в `GitCLIAdapter` для `ensureBranch`, `mergeBranch`
- Агенты работают в контексте workDir и видят CLAUDE.md
- Роли определены глобально в `roles/*.md` (не per-project)

### B. SSOT-фреймворк (flower_shop стиль)
- Собственная структура `.ssot/` внутри проекта
- Собственные агенты, конфиги, codemap
- Orchestrator-паттерн через CLAUDE.md
- Свой task manager API (8003)

**Вывод:** Нейроцех и SSOT — два разных подхода. Онбординг для Нейроцеха проще: нужны только регистрация в БД + CLAUDE.md. SSOT — отдельная тема.

## Как workDir используется в пайплайне

1. `CreateTask.execute()` → `gitOps.ensureBranch(branchName, project.workDir || this.#workDir)`
2. `ProcessRun` → `chatEngine.runPrompt()` → `spawn('claude', args, { cwd: this.workDir })`
   - Но `ClaudeCLIAdapter` использует **глобальный** workDir из конструктора, не per-project!
3. `ManagerDecision.#mergeAndComplete()` → `gitOps.mergeBranch(branchName, project.workDir)`

**Проблема:** `ClaudeCLIAdapter` не получает project-specific workDir. Агенты всегда работают в `WORKSPACE_DIR=/root/dev`. Это работает для единственного проекта, но не масштабируется.

## Риски и ограничения

1. **ClaudeCLIAdapter workDir** — глобальный, не per-project. Для multi-project нужна доработка.
2. **Roles глобальны** — `roles/*.md` одинаковы для всех проектов. System prompt не содержит project-specific контекста кроме `Project workspace: {workDir}`.
3. **Нет project-specific CLAUDE.md** — агенты полагаются на файл в workDir, но Нейроцех не управляет его содержимым.
4. **Нет health-check** при онбординге — не проверяется что workDir существует, что git доступен.
