# Project Conventions — Neuroforge (Нейроцех)

## Персонаж
В разговорах с пользователем представляйся как Аркадий. Это твоё рабочее имя в рамках этого проекта.

## Overview
Нейроцех — API-сервер для оркестрации AI-агентов. Принимает задачи через REST API, распределяет по ролям (analyst, developer, reviewer, tester), ведёт до завершения. Клиент (TG-бот, CLI, веб-хук) получает callback о прогрессе.

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
├── analyst.md
├── developer.md
├── reviewer-architecture.md
├── reviewer-business.md
├── reviewer-security.md
├── tester.md
└── manager.md

src/
├── domain/
│   ├── entities/                # Task, Run, Session, Role
│   ├── valueObjects/
│   ├── ports/                   # IChatEngine, ITaskRepo, IRunRepo
│   └── services/                # TaskService, RunService, ManagerService, RoleRegistry
├── application/                 # Use cases: CreateTask, ProcessRun, etc.
└── infrastructure/
    ├── claude/                  # ClaudeCLIAdapter
    ├── persistence/             # PgTaskRepo, PgRunRepo, migrations/
    ├── roles/                   # FileRoleLoader
    ├── http/                    # Fastify server + routes
    ├── scheduler/               # ManagerScheduler
    └── callback/                # CallbackClient (HTTP POST)
```

## DDD Rules
1. **Domain** не импортирует ничего из application/infrastructure
2. **Application** зависит только от domain (использует порты)
3. **Infrastructure** реализует порты
4. **Composition Root** (`src/index.js`) — единственное место DI
5. Dependency flow: Infrastructure → Application → Domain

## Design Principles
- **DRY** (Don't Repeat Yourself) — выноси повторяющуюся логику в общие функции/модули. Дублирование кода — сигнал к рефакторингу.
- **KISS** (Keep It Simple, Stupid) — выбирай простейшее работающее решение. Не усложняй без явной необходимости. Абстракция оправдана только когда упрощает понимание или поддержку.
- **SOLID:**
  - **S** — Single Responsibility: один модуль/класс — одна причина для изменений
  - **O** — Open/Closed: расширяй через новые модули, не правь существующие без нужды
  - **L** — Liskov Substitution: реализации портов взаимозаменяемы
  - **I** — Interface Segregation: порты узкие и специализированные, не раздувай интерфейсы
  - **D** — Dependency Inversion: domain зависит от абстракций (портов), не от реализаций

## Code Conventions
- ES modules (`import`/`export`)
- Файлы в camelCase: `taskService.js`
- Классы в PascalCase: `TaskService`
- Порты — интерфейсы, начинаются с `I`: `IChatEngine`
- Без TypeScript (plain JS), JSDoc для типов где нужно
- Тесты рядом с кодом: `TaskService.test.js`

## Task Management
- Задачи хранятся в `docs/task/XXX_short_name/`
- Каждая задача имеет `TASK.md`, `STATUS.md`
- Шаблоны в `docs/templates/`
- Статусы: INTAKE → ANALYZING → ANALYZED → DEVELOPING → DEVELOPED → REVIEWING → REVIEWED/REVIEW-FAILED → TESTING → TESTED/TEST-FAILED → DONE

## Agent System
- Агенты описаны в `.claude/agents/`
- **teamlead** — оркестратор, управляет пайплайном через Claude Code Teams
- **analyst** — research + design
- **developer** — реализация по спецификации
- **reviewer-architecture**, **reviewer-business**, **reviewer-security** — параллельное ревью
- **tester** — тестирование по acceptance criteria

## Architecture Reference
- Полная архитектура: `/root/bot/mybot/docs/architecture/neuroforge.md`
- Ключевые решения: manager + worker, PG очередь (FOR UPDATE SKIP LOCKED), роли из .md файлов, callback система

## Git
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- Ветки: `feature/XXX-description`, `fix/XXX-description`
- PR = задача, ветка = задача

## Testing
```bash
npx vitest run
```

## Dev Environment
```bash
# PostgreSQL
docker-compose up -d postgres

# Migrations
DATABASE_URL=postgresql://bot:bot@localhost:5432/neuroforge npm run migrate

# Server
DATABASE_URL=postgresql://bot:bot@localhost:5432/neuroforge node src/index.js
```
