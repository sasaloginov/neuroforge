# Project Conventions — Neuroforge (Нейроцех)

## Персонаж
В разговорах с пользователем представляйся как Аркадий. Это твоё рабочее имя в рамках этого проекта.

## Overview
Нейроцех — API-сервер для оркестрации AI-агентов. Принимает задачи через REST API, распределяет по ролям (analyst → developer → reviewer), ведёт до завершения. Клиент (TG-бот, CLI, веб-хук) получает callback о прогрессе.

## Tech Stack
- **Runtime:** Node.js 22
- **HTTP:** Fastify (schema validation)
- **AI:** Claude Code CLI (`claude -p`)
- **DB:** PostgreSQL (задачи, сессии, очередь)
- **Query Builder:** Knex.js (миграции + queries)
- **Architecture:** DDD — Domain / Application / Infrastructure
- **Container:** Docker + docker-compose
- **Language:** JavaScript (ES modules)

## Project Structure
```
roles/                           # определения ролей (source of truth)
├── analyst.md                   # исследование + проектирование (opus)
├── developer.md                 # реализация кода (opus)
├── reviewer.md                  # единое ревью: архитектура + бизнес + безопасность (sonnet)
├── pm.md                        # PM-оркестратор для edge cases (sonnet)
├── manager.md                   # legacy manager (не используется в v2)
├── reviewer-architecture.md     # legacy (не используется в v2)
├── reviewer-business.md         # legacy (не используется в v2)
├── reviewer-security.md         # legacy (не используется в v2)
└── tester.md                    # legacy (не используется в v2)

.neuroforge/                     # системная папка Нейроцеха
├── config.json                  # метаданные проекта (стек, команды, описание)
└── docs/                        # артефакты задач
    └── <shortId>/               # research/, design/spec.md, context.md

docs/
├── task/                        # определения задач (TASK.md)
├── adr/                         # architecture decision records
├── architecture/
├── process/
└── templates/

src/
├── domain/
│   ├── entities/                # Task, Run, Session, Role
│   ├── valueObjects/            # BranchName, ReviewFindings, TaskMode
│   ├── ports/                   # IChatEngine, ITaskRepo, IRunRepo, IGitOps
│   └── services/                # TaskService, RunService, RoleRegistry
├── application/                 # Use cases (см. Pipeline v2 ниже)
└── infrastructure/
    ├── claude/                  # ClaudeCLIAdapter
    ├── persistence/             # PgTaskRepo, PgRunRepo, PgSessionRepo, migrations/
    ├── roles/                   # FileRoleLoader
    ├── git/                     # GitCLIAdapter (ensureBranch, mergeBranch, syncWorktrees)
    ├── http/                    # Fastify server + routes
    ├── scheduler/               # ManagerScheduler + Worker
    └── callback/                # CallbackClient (HTTP POST)
```

## Pipeline v2 — агентный пайплайн

### Роли (3 активных)

| Роль | Модель | Что делает |
|------|--------|-----------|
| **analyst** | opus | Исследует проект, создаёт research, spec, context.md в `.neuroforge/docs/<shortId>/` |
| **developer** | opus | Реализует код по спецификации. Resume'ит CLI-сессию analyst'а (shared context) |
| **reviewer** | sonnet | Единое ревью по 3 направлениям: архитектура (DDD/SOLID), бизнес-логика (AC), безопасность (OWASP) |

PM (sonnet) вызывается только для edge cases (failed runs, нестандартные ситуации).

### Стандартный пайплайн
```
CreateTask
 ├─ генерирует branchName, создаёт git-ветку
 ├─ запускает analyst
 │   └─ research + spec + context.md → commit
 ├─ ManagerDecision (детерминистический): analyst_done → developer
 ├─ developer (--resume сессии analyst'а)
 │   └─ код + тесты → commit
 ├─ ManagerDecision: developer_done → reviewer
 ├─ reviewer
 │   └─ git diff main..HEAD → VERDICT: PASS/FAIL
 ├─ если FAIL (CRITICAL/MAJOR/HIGH/MINOR):
 │   ├─ developer fix (--resume) → re-review
 │   └─ макс 3 ревизии → escalation
 ├─ если PASS (только LOW допустимы):
 │   └─ merge + complete
 └─ callback на каждом шаге
```

### Артефакты аналитика
Всё строго в `.neuroforge/docs/<shortId>/`:
```
.neuroforge/docs/<shortId>/
├── research/          # файлы исследований
│   └── <slug>.md
├── design/
│   └── spec.md        # спецификация для developer'а
└── context.md         # карта затрагиваемого кода (макс 150 строк)
```
Developer проверяет наличие этих файлов перед началом работы. Без них — СТОП.

### Session sharing
Developer автоматически resume'ит CLI-сессию analyst'а — видит весь контекст без повторного чтения файлов. Реализовано в `ProcessRun.js`: при запуске developer'а ищется сессия analyst'а для этой задачи, и её `cliSessionId` передаётся в developer'скую сессию.

### Severity и блокировка
- **FAIL** = CRITICAL, MAJOR, HIGH или MINOR
- **PASS** = только LOW
- Developer при fix'е исправляет всё кроме LOW

### Use cases (application/)

| Use case | Что делает |
|----------|-----------|
| **CreateTask** | Создаёт задачу, генерирует branchName, создаёт git-ветку, запускает analyst |
| **ManagerDecision** | Детерминистический оркестратор (analyst→developer→reviewer→merge). PM LLM только для edge cases |
| **ProcessRun** | Берёт queued run, выполняет через Claude CLI, session sharing |
| **CancelTask** | Отменяет задачу, абортит running run |
| **RestartTask** | Перезапускает failed задачу |
| **ResumeResearch** | research_done → full mode, запускает developer |
| **ReplyToQuestion** | Ответ владельца → ManagerDecision |
| **StartNextPendingTask** | Активирует следующую из очереди |
| **EnqueueTask** | Ручная активация pending задачи |

## DDD Rules
1. **Domain** не импортирует ничего из application/infrastructure
2. **Application** зависит только от domain (использует порты)
3. **Infrastructure** реализует порты
4. **Composition Root** (`src/index.js`) — единственное место DI
5. Dependency flow: Infrastructure → Application → Domain

## Design Principles
- **DRY** — выноси повторяющуюся логику. Дублирование кода — сигнал к рефакторингу.
- **KISS** — выбирай простейшее работающее решение. Не усложняй без явной необходимости.
- **SOLID:**
  - **S** — Single Responsibility: один модуль/класс — одна причина для изменений
  - **O** — Open/Closed: расширяй через новые модули, не правь существующие без нужды
  - **L** — Liskov Substitution: реализации портов взаимозаменяемы
  - **I** — Interface Segregation: порты узкие и специализированные
  - **D** — Dependency Inversion: domain зависит от абстракций (портов), не от реализаций

## Code Conventions
- ES modules (`import`/`export`)
- Файлы в camelCase: `taskService.js`
- Классы в PascalCase: `TaskService`
- Порты — интерфейсы, начинаются с `I`: `IChatEngine`
- Без TypeScript (plain JS), JSDoc для типов где нужно
- Тесты рядом с кодом: `TaskService.test.js`

## Git
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- Ветки именуются по shortId: `BOT-14/billing-system-...`, `NF-21/pipeline-v2-...`
- Ветка создаётся автоматически при CreateTask
- Merge в main после успешного ревью

## Testing
```bash
npx vitest run
```

## Dev Environment
```bash
# PostgreSQL (через docker-compose mybot)
# БД: neuroforge, user: bot, password: bot

# Migrations
DATABASE_URL=postgresql://bot:bot@localhost:5432/neuroforge npm run migrate

# Server (прямой запуск)
DATABASE_URL=postgresql://bot:bot@localhost:5432/neuroforge node src/index.js

# Перезапуск (с остановкой старого процесса)
DATABASE_URL=postgresql://bot:bot@localhost:5432/neuroforge WORKSPACE_DIR=/root/dev bash restart.sh

# Логи
tail -f /tmp/neuroforge.log
```
