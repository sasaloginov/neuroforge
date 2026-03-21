# Архитектура: Telegram Bot + Нейроцех (Neuroforge)

## Мотивация

Текущая архитектура смешивает TG-бота и работу с Claude CLI в одном процессе. Background tasks (задача 003) показали ограничения этого подхода: сложный late-binding, невозможность управлять несколькими сессиями параллельно, нет персистентности задач.

Новый подход: **разделить проект на два независимых компонента**.

---

## Высокоуровневая схема

```
┌──────────────────┐         HTTP/REST          ┌──────────────────────────┐
│                  │ ──────────────────────────► │                          │
│   Telegram Bot   │     постановка задач,       │       Нейроцех         │
│   (grammy)       │     отправка сообщений      │   (Bot Workshop API)     │
│                  │                             │                          │
│                  │ ◄────────────────────────── │   ┌──────────────────┐   │
│                  │      callback (webhook)      │   │  Manager Bot     │   │
└──────────────────┘                             │   │  (cron/scheduler)│   │
       │                                         │   └────────┬─────────┘   │
       │ long polling                            │            │ периодически│
       ▼                                         │            ▼             │
   Telegram API                                  │   - чекает сессии        │
                                                 │   - продвигает задачи    │
                                                 │   - шлёт callback        │
                                                 └──────────┬───────────────┘
                                                            │
                                                   ┌────────┴────────┐
                                                   │                 │
                                              Claude CLI        PostgreSQL
                                              (claude -p)
```

---

## Компонент 1: Telegram Bot

**Ответственность:** только взаимодействие с пользователем через Telegram.

### Что делает
- Принимает сообщения от пользователей (long polling)
- Авторизация (allowed users)
- Команды: /start, /reset, /task, etc.
- Форматирование ответов (markdown → HTML)
- Разбиение длинных сообщений
- Вызывает API Нейроцеха для всей работы с AI

### Что НЕ делает
- Не запускает Claude CLI напрямую
- Не управляет сессиями
- Не хранит состояние задач

### Стек
- grammy (long polling)
- HTTP-клиент для обращения к Нейроцеху (fetch / undici)
- Минимальный конфиг: BOT_TOKEN, ALLOWED_USERS, NEUROFORGE_URL

### Структура
```
src/telegram/
├── bot.js              # grammy setup, middleware
├── handlers/
│   ├── messageHandler.js
│   └── commandHandler.js
├── utils/
│   ├── splitMessage.js
│   └── markdownToHtml.js
├── middleware/
│   └── auth.js
├── client/
│   └── NeuroforgeClient.js   # HTTP-клиент к API Нейроцеха
└── callback/
    └── callbackServer.js      # HTTP-сервер для приёма callback от Нейроцеха
```

---

## Компонент 2: Нейроцех (Bot Workshop API)

**Ответственность:** управление AI-сессиями, ролями, задачами.

### Внешний API (необходимый и достаточный минимум)

Принцип: клиент (TG-бот или любой другой) **не управляет** внутренними сущностями (сессии, шаги, роли). Клиент ставит задачу, отвечает на вопросы, получает результат. Всё остальное — внутреннее дело Нейроцеха.

#### Клиент → Нейроцех

Все запросы требуют `Authorization: Bearer <api_key>`.

```
-- Управление пользователями (только admin)
POST   /users                    — создать пользователя
GET    /users                    — список пользователей
DELETE /users/:id                — удалить пользователя

-- Управление API-ключами
POST   /api-keys                 — создать ключ (указать name, опционально project_id для scope)
GET    /api-keys                 — список своих ключей
DELETE /api-keys/:id             — отозвать ключ

-- Проекты
POST   /projects                 — зарегистрировать проект (repo_url обязателен)
GET    /projects                 — список проектов (только доступные по scope ключа)
GET    /projects/:name           — информация о проекте
GET    /projects/:name/tasks     — список задач проекта (фильтр по статусу)

-- Задачи
POST   /tasks                    — поставить задачу
POST   /tasks/:id/reply          — ответить на вопрос Нейроцеха
POST   /tasks/:id/cancel         — отменить задачу
GET    /tasks/:id                — статус задачи (fallback, если callback не дошёл)
```

#### Нейроцех → Клиент (callback, 4 типа)
```
POST {callbackUrl}

// Прогресс — задача перешла на новый этап
{ "type": "progress", "taskId": "uuid", "stage": "review", "message": "Код написан, отправлен на ревью" }

// Вопрос — Нейроцех остановилась и ждёт ответа
{ "type": "question", "taskId": "uuid", "questionId": "uuid", "question": "OAuth через Google или GitHub?", "context": "..." }

// Готово
{ "type": "done", "taskId": "uuid", "summary": "Фича реализована, 12 файлов, 47 тестов" }

// Ошибка
{ "type": "failed", "taskId": "uuid", "error": "..." }
```

Все callback содержат `callbackMeta` — непрозрачный JSONB, который клиент передал при создании задачи. Нейроцех не интерпретирует его содержимое — просто возвращает обратно. Клиент сам решает что там хранить (chatId, userId, webhookId — что угодно).

### Модель данных (PostgreSQL)

```sql
-- Роли загружаются из файлов roles/*.md при старте приложения.
-- Таблицы roles нет — role_name валидируется на уровне приложения.

-- Пользователи (люди-администраторы Нейроцеха)
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(128) NOT NULL,
    role        VARCHAR(32) NOT NULL DEFAULT 'member',  -- admin | member
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- API-ключи (для сервисов: TG-бот, веб-хук, CLI и т.д.)
CREATE TABLE api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(128) NOT NULL,              -- "tg-bot-prod", "webhook-myapp"
    key_hash    VARCHAR(256) NOT NULL UNIQUE,       -- SHA-256 от токена, сам токен не хранится
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id  UUID REFERENCES projects(id),       -- NULL = доступ ко всем проектам пользователя
    expires_at  TIMESTAMPTZ,                        -- NULL = бессрочный
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_user_id  ON api_keys(user_id);

-- Проекты (обязательная сущность, регистрируется при добавлении в Нейроцех)
CREATE TABLE projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(128) UNIQUE NOT NULL,  -- "mybot", "flower-api"
    repo_url    VARCHAR(512) NOT NULL,         -- git-репозиторий: github, gitlab, bitbucket, self-hosted (обязателен)
    work_dir    VARCHAR(512),                  -- "/root/dev/mybot" (авто если не указан)
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Сессии Claude CLI
CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id),
    cli_session_id  VARCHAR(255),             -- ID сессии в Claude CLI
    role_name       VARCHAR(64) NOT NULL,     -- имя файла роли (без .md), валидация в приложении
    status          VARCHAR(32) DEFAULT 'active',  -- active, expired, closed
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_project_id ON sessions(project_id);

-- Задачи
CREATE TABLE tasks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id),
    title       VARCHAR(255) NOT NULL,
    description TEXT,
    status      VARCHAR(32) DEFAULT 'pending',  -- pending, in_progress, done, failed, cancelled
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tasks_project_id ON tasks(project_id);
CREATE INDEX idx_tasks_status ON tasks(status);

-- Шаги выполнения задачи (flow)
CREATE TABLE task_steps (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role_name   VARCHAR(64) NOT NULL     -- имя роли из roles/*.md,
    session_id  UUID REFERENCES sessions(id),
    step_order  INTEGER NOT NULL,
    prompt_template TEXT NOT NULL,         -- шаблон промпта (может использовать результат предыдущего шага)
    status      VARCHAR(32) DEFAULT 'pending',  -- pending, running, done, failed, timeout
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_task_steps_task_id ON task_steps(task_id);

-- Очередь выполнения (async runs)
CREATE TABLE runs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID REFERENCES sessions(id),
    task_id     UUID REFERENCES tasks(id),
    step_id     UUID REFERENCES task_steps(id),
    role_name   VARCHAR(64) NOT NULL     -- имя роли из roles/*.md,
    prompt      TEXT NOT NULL,
    response    TEXT,
    status      VARCHAR(32) DEFAULT 'queued',  -- queued, running, done, failed, timeout, cancelled
    callback_url VARCHAR(512),                  -- куда отправить результат
    callback_meta JSONB,                        -- доп. данные для callback (chatId, messageId, etc.)
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    duration_ms INTEGER,
    error       TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_task_id ON runs(task_id);

-- Лог сообщений (опционально, для аудита)
CREATE TABLE message_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID REFERENCES sessions(id),
    direction   VARCHAR(8) NOT NULL,  -- 'in' | 'out'
    content     TEXT NOT NULL,
    tokens_in   INTEGER,
    tokens_out  INTEGER,
    duration_ms INTEGER,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_message_log_session_id ON message_log(session_id);
```

### Стек
- **HTTP-сервер:** Fastify (быстрый, schema validation из коробки)
- **БД:** PostgreSQL (задачи, сессии, роли, логи)
- **ORM/Query:** Knex.js (миграции + query builder, без тяжёлого ORM)
- **Claude CLI:** claude -p (как сейчас, через spawn)

### Структура (DDD)
```
roles/                               # определения ролей (source of truth)
├── default.md
├── analyst.md
├── developer.md
├── reviewer-architecture.md
├── reviewer-business.md
├── reviewer-security.md
├── tester.md
└── manager.md

src/neuroforge/
├── domain/
│   ├── entities/
│   │   ├── Session.js
│   │   ├── Role.js               # value object, загружается из .md файлов
│   │   ├── Task.js
│   │   └── TaskStep.js
│   ├── ports/
│   │   ├── IChatEngine.js        # порт к Claude CLI
│   │   ├── ISessionRepo.js
│   │   ├── ITaskRepo.js
│   │   └── ITaskStepRepo.js
│   └── services/
│       ├── RoleRegistry.js       # загрузка и хранение ролей из .md файлов
│       ├── SessionService.js     # управление сессиями
│       ├── TaskService.js        # управление задачами и флоу
│       ├── RunService.js         # выполнение промптов (executor)
│       └── ManagerService.js     # логика менеджер-бота (оркестрация)
├── application/
│   ├── CreateSession.js
│   ├── SendMessage.js
│   ├── CompactSession.js
│   ├── CreateTask.js
│   ├── EnqueueRun.js             # поставить промпт в очередь
│   └── ProcessRuns.js            # обработать очередь (вызывается менеджером)
├── infrastructure/
│   ├── claude/
│   │   └── ClaudeCLIAdapter.js   # переиспользуем текущий адаптер
│   ├── persistence/
│   │   ├── knexfile.js
│   │   ├── migrations/
│   │   ├── PgSessionRepo.js
│   │   ├── PgTaskRepo.js
│   │   ├── PgTaskStepRepo.js
│   │   └── PgRunRepo.js
│   ├── roles/
│   │   └── FileRoleLoader.js     # парсинг .md файлов (frontmatter + body)
│   ├── http/
│   │   ├── server.js             # Fastify setup
│   │   └── routes/
│   │       ├── sessionRoutes.js
│   │       ├── taskRoutes.js
│   │       └── runRoutes.js
│   ├── scheduler/
│   │   └── ManagerScheduler.js   # cron/setInterval — запускает менеджер-бота
│   └── callback/
│       └── CallbackClient.js     # HTTP-клиент для отправки callback в TG-бот
└── index.js                      # composition root
```

---

## Ключевой сценарий: POST /tasks

```
POST /tasks
{
  "prompt": "Добавить OAuth авторизацию через Google",
  "projectId": "uuid",
  "callbackUrl": "http://tg-bot:3001/callback",
  "callbackMeta": { "chatId": 12345, "replyToMessageId": 789 }
}
```

**Ответ (сразу, 202 Accepted):**
```json
{
  "taskId": "uuid",
  "status": "queued"
}
```

Задача попадает в очередь. Нейроцех сама решает, какие роли задействовать, в каком порядке, и ведёт задачу до завершения. Клиент получает callback'и о прогрессе, вопросах и результате.

---

## Manager Bot (Менеджер-бот)

Центральный компонент оркестрации. Запускается периодически (cron / setInterval).

### Что делает на каждом тике

1. **Проверяет очередь runs** (status = 'queued')
   - Берёт следующий run из очереди
   - Загружает конфиг роли (model, timeout, system_prompt, allowed_tools)
   - Запускает `claude -p` с параметрами роли
   - Обновляет status → 'running'
   - По завершении: сохраняет response, status → 'done' / 'failed' / 'timeout'
   - Отправляет callback на callbackUrl с результатом

2. **Проверяет задачи** (tasks с активными шагами)
   - Если текущий шаг завершён (step done) → решает, запускать ли следующий
   - Формирует промпт для следующего шага (может включать результат предыдущего)
   - Создаёт новый run для следующего шага
   - Если все шаги завершены → обновляет task status → 'done'
   - Шлёт callback с уведомлением о прогрессе / завершении

3. **Чекает running сессии**
   - Мониторит зависшие runs (running дольше timeout)
   - Помечает как 'timeout', шлёт callback

### Конфигурация

```env
MANAGER_INTERVAL_MS=10000        # интервал проверки (10 сек)
MANAGER_MAX_CONCURRENT=3         # макс. параллельных runs
MANAGER_ENABLED=true             # можно отключить менеджера
```

### Логика оркестрации задач

Manager Bot — это тоже Claude-сессия с ролью "manager". Он получает контекст задачи и принимает решения:

```
Роль: manager
Промпт: "Задача '{title}' на этапе {currentStep}.
         Результат предыдущего шага: {previousResult}.
         Доступные следующие шаги: {nextSteps}.
         Реши: продвигать на следующий этап или нет?
         Если да — сформируй промпт для следующей роли."
```

Это позволяет менеджеру **принимать интеллектуальные решения**, а не просто механически двигать задачу по конвейеру.

---

## Сценарий: полный цикл задачи

Пример: пользователь ставит задачу, Нейроцех ведёт её до конца.

```
User → TG Bot:     "Добавить OAuth авторизацию через Google"
                     ↓
TG Bot → POST /tasks { prompt, projectId: "uuid", callbackUrl, callbackMeta }
                     ↓
Нейроцех → 202    { taskId, status: "queued" }
TG Bot → User:      "Задача принята, начинаю анализ."

                     ↓ analyst анализирует код, находит вопрос ↓

← callback:         { type: "question", taskId, questionId: "q1",
                      question: "OAuth через Google, GitHub, или оба?" }
TG Bot → User:      "Вопрос: OAuth через Google, GitHub, или оба?"
User → TG Bot:      "Только Google"
TG Bot → POST /tasks/:id/reply { questionId: "q1", answer: "Только Google" }

                     ↓ analyst дописывает спеку, формирует план ↓

← callback:         { type: "progress", stage: "analysis_done",
                      message: "План: 3 файла, OAuth2 через Google" }

                     ↓ developer кодит ↓

← callback:         { type: "progress", stage: "development",
                      message: "Разработка в процессе" }

                     ↓ reviewer проверяет → замечания → developer правит (внутренний цикл) ↓

← callback:         { type: "progress", stage: "review_fixes",
                      message: "2 замечания от ревьюера, исправляю" }

                     ↓ tester тестирует ↓

← callback:         { type: "done", summary: "OAuth Google готов. 5 файлов, 23 теста, все зелёные" }
TG Bot → User:      "Задача выполнена: OAuth Google готов."
```

### Что важно в этом сценарии:
- **question** блокирует задачу — Нейроцех не гадает, а ждёт ответа
- **progress** информирует, но не требует реакции
- Внутренний цикл review ↔ code скрыт от клиента — он видит только прогресс
- Клиент не управляет шагами, ролями, сессиями — это внутренняя кухня

---

## Роли — файловая система как источник истины

Роли определяются как `.md` файлы в директории `roles/`. Каждый файл — полное описание роли: system prompt, конфигурация, инструкции. При старте Нейроцех загружает все файлы из `roles/` и регистрирует роли.

### Структура директории

```
roles/
├── default.md
├── analyst.md
├── developer.md
├── reviewer-architecture.md
├── reviewer-business.md
├── reviewer-security.md
├── tester.md
└── manager.md
```

### Формат файла роли

```markdown
---
name: developer
model: opus
timeout_ms: 600000
allowed_tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
  - Edit
---

# Developer — Разработчик

Ты — разработчик проекта. Реализуешь код по спецификациям.

## Процесс работы
...полный system prompt...
```

Frontmatter содержит конфигурацию (model, timeout, allowed_tools). Тело файла (после frontmatter) — полный system prompt, который передаётся в `claude -p --system-prompt`.

### Загрузка ролей

При старте Нейроцеха:
1. Читает все `roles/*.md` файлы
2. Парсит frontmatter → конфигурация
3. Извлекает тело → system prompt
4. Регистрирует роли в памяти (Map<name, RoleConfig>)

БД **не хранит определения ролей** — только ссылки по `role_name`. Это даёт:
- **Версионирование** — роли в git, видны диффы
- **Прозрачность** — весь промпт читается как документ
- **Простота редактирования** — не нужен SQL / admin panel
- **Консистентность** — один формат с `.claude/agents/`

### Таблица roles в БД

Таблица `roles` из схемы **убирается**. Вместо неё — FK `role_name VARCHAR(64)` в таблицах `sessions`, `task_steps`, `runs` ссылается на имя файла (без `.md`). Валидация — на уровне приложения при загрузке.

### Предустановленные роли

| Файл | Model | Timeout | Инструменты |
|------|-------|---------|-------------|
| `default.md` | opus | 120s | Read, Glob, Grep, WebSearch, WebFetch, Bash |
| `analyst.md` | opus | 300s | Read, Glob, Grep, WebSearch, WebFetch |
| `developer.md` | opus | 600s | Read, Glob, Grep, Bash, Write, Edit |
| `reviewer-architecture.md` | sonnet | 180s | Read, Glob, Grep |
| `reviewer-business.md` | sonnet | 180s | Read, Glob, Grep |
| `reviewer-security.md` | sonnet | 180s | Read, Glob, Grep |
| `tester.md` | sonnet | 300s | Read, Glob, Grep, Bash |
| `manager.md` | opus | 120s | Read, Glob, Grep |

---

## Взаимодействие TG Bot ↔ Нейроцех

### Простой чат (не через Нейроцех)

Простой чат (ассистент с памятью) остаётся в TG-боте как сейчас — прямой вызов Claude CLI. Нейроцех только для задач.

### Запрос статуса проекта

```
User → TG Bot: "Какие задачи по mybot?"
TG Bot → GET /projects/mybot/tasks?status=in_progress
Нейроцех → 200 [{ id, title, status, stage, updatedAt }, ...]
TG Bot → User: "По mybot: 1 задача в работе (OAuth — на этапе review), 3 в бэклоге"
```

Прямой запрос в БД, мгновенный ответ, без агентов.

### Callback endpoint на TG-боте

TG-бот поднимает HTTP-сервер для приёма callback от Нейроцеха:

```
POST /callback
{
  "type": "progress" | "question" | "done" | "failed",
  "taskId": "uuid",
  "stage": "...",              // для progress
  "message": "...",            // для progress
  "questionId": "uuid",        // для question
  "question": "...",           // для question
  "summary": "...",            // для done
  "error": "...",              // для failed
  "callbackMeta": { "chatId": 123, "replyToMessageId": 789 }
}
```

Клиент использует `callbackMeta` чтобы понять куда доставить результат. Нейроцех не знает что там внутри — это дело клиента.

---

## Деплой

### Нейроцех (dev-сервер) — /root/neuroforge/docker-compose.yml
```yaml
services:
  neuroforge:
    build: .
    environment:
      - DATABASE_URL=postgresql://bot:bot@postgres:5432/botdb
      - CLAUDE_MODEL=${CLAUDE_MODEL:-opus}
      - MANAGER_INTERVAL_MS=${MANAGER_INTERVAL_MS:-10000}
      - MANAGER_MAX_CONCURRENT=${MANAGER_MAX_CONCURRENT:-3}
    depends_on:
      - postgres
    volumes:
      - ${WORKSPACE_DIR:-/root/dev}:/workspace   # multi-project dev workspace

  postgres:
    image: pgvector/pgvector:pg17
    environment:
      - POSTGRES_USER=${PG_USER:-bot}
      - POSTGRES_PASSWORD=${PG_PASSWORD:-bot}
      - POSTGRES_DB=${PG_DB:-botdb}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "${PG_PORT:-5432}:5432"

  ollama:
    image: ollama/ollama
    profiles: ["with-ollama"]   # опционально: docker-compose --profile with-ollama up
    ports:
      - "11434:11434"

volumes:
  pgdata:
```

### Проект заказчика — свой docker-compose.yml
```yaml
# Самодостаточный, не зависит от Нейроцеха
services:
  app:
    build: .
    environment:
      - DATABASE_URL=postgresql://bot:bot@postgres:5432/appdb
      - BOT_TOKEN=${BOT_TOKEN}

  postgres:
    image: pgvector/pgvector:pg17
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

Вся кастомизация через `.env` — ноль правок в docker-compose.

---

## Миграция с текущей архитектуры

### Что переиспользуется
- `ClaudeCLIAdapter` — ядро взаимодействия с Claude CLI (адаптировать под новые параметры роли)
- `splitMessage.js`, `markdownToHtml.js` — утилиты TG-бота
- `auth.js` — middleware авторизации
- Логика Session entity (расширить под новую схему)

### Что удаляется
- BackgroundTask, TaskService (task 003) — заменяется на tasks/task_steps в БД
- InMemoryTaskRepo — заменяется на PgTaskRepo
- FileSessionRepo — заменяется на PgSessionRepo
- TelegramNotifier — TG-бот сам решает когда и что нотифицировать
- Late-binding прокси в index.js

### Порядок миграции
1. Поднять PostgreSQL, создать схему
2. Реализовать Нейроцех (API + persistence + Claude CLI adapter)
3. Написать NeuroforgeClient для TG-бота
4. Переключить TG-бот на использование Нейроцеха вместо прямого вызова Claude CLI
5. Удалить старый код (background tasks, file session repo, etc.)

---

## Принятые решения

1. **Manager Bot** — LLM-агент (Claude-сессия с ролью "manager"). Запускается после каждого завершённого run. Получает полный контекст задачи: описание, шаблон пайплайна (как ориентир), отчёт завершившегося агента (`runs.response`) и ссылки на файловые артефакты в `cwd` проекта. Принимает решение о следующем шаге: в штатной ситуации — следующий по шаблону, при необходимости — отклоняется (ask_owner, retry, skip, fail). MCP tools manager'а: `spawn_run(role, prompt)`, `ask_owner(question)`, `complete_task(summary)`, `fail_task(reason)`.
2. **Отдельный проект** — Нейроцех это самостоятельный репозиторий (`sasaloginov/neuroforge`), не часть mybot. Универсальный инструмент разработки для любых проектов (боты, веб-приложения, API-сервисы и т.д.). Первая версия создаётся на базе mybot — переиспользуем рабочий движок (Claude CLI, DDD, память). Следующие проекты уже создаются из Нейроцеха
3. **Архитектура выполнения: manager + worker** — два типа процессов:
    - **manager** — LLM-агент, запускается по событию (PG LISTEN/NOTIFY) после завершения каждого run. Читает историю задачи (runs + файловые артефакты в cwd), принимает решение о следующем шаге, вызывает `spawn_run()`. Polling каждые 15 сек как fallback на случай потери уведомления.
    - **worker** (`node worker.js`) — берёт один run из очереди (`SELECT ... FOR UPDATE SKIP LOCKED`), запускает `claude -p`, сохраняет `runs.response` (краткий текстовый отчёт агента), выходит. Параллельность — несколько воркеров.
    - Артефакты агентов живут в файлах проекта (`cwd`): спеки, код, отчёты ревьюеров. `runs.response` — краткое резюме для manager'а, детали — в файлах.
    - Таймаут: manager смотрит runs где `started_at + timeout_ms < now` → сбрасывает в `interrupted` → recovery. PID хранить не нужно.
4. **Маршрутизация** — owner → Нейроцех, остальные → ассистент
5. **Коммуникация Бот ↔ Нейроцех** — HTTP/REST. Бот шлёт запросы в API Нейроцеха, результаты приходят через HTTP callback. Очередь задач — PG (FOR UPDATE SKIP LOCKED + LISTEN/NOTIFY). Без Redis — одна БД для данных и очередей
6. **Простой чат** — как сейчас (ассистент с памятью), Нейроцех только для задач
7. **Permissions** — все агенты в Docker запускаются с `--dangerously-skip-permissions`, безопасность через изоляцию контейнера
8. **Структура на сервере:**
   ```
   /root/
   ├── bot/mybot/              ← ПРОД бот (main, работает)
   ├── dev/                    ← DEV workspace (Docker volume Нейроцеха)
   │   ├── mybot/              ← клон бота (feature-ветки)
   │   ├── web-app/            ← веб-проект
   │   └── ...                 ← любые проекты
   └── neuroforge/            ← сама Нейроцех (отдельный репо + Docker)
   ```
   Агенты работают в `/workspace/<project>/`, коммитят в feature-ветки.
   Прод обновляется через merge в main → git pull → рестарт.
9. **Два PostgreSQL** — прод-бот (mybot) имеет свой PG в своём docker-compose. Нейроцех поднимает свой PG для dev-проектов (отдельная БД на каждый) + общие сервисы (Ollama). У заказчика на проде — свой docker-compose в проекте, без Нейроцеха.
10. **Деплой проектов** — проект читает `DATABASE_URL` из ENV и не знает откуда пришёл Postgres. На dev-сервере — общий PG Нейроцеха, у заказчика — свой из docker-compose проекта. Ноль правок в коде.
11. **Контекст проектов** — каждый проект в `/root/dev/` имеет свой `CLAUDE.md` и `.claude/` с агентами и настройками. Claude CLI подхватывает их автоматически из `cwd`. Это позволяет каждому проекту иметь свои конвенции, стек, правила.
12. **Шаблон проекта** — Нейроцех при инициализации нового проекта (`neuroforge init <name> --stack node`) раскладывает базовый набор файлов:
    - `CLAUDE.md` — шаблон с конвенциями проекта
    - `.claude/agents/` — стандартные агенты (analyst, developer, reviewer-*, tester)
    - `docs/templates/` — TASK.md, STATUS.md, ADR.md
    - `docs/process/` — agent-guide.md, workflow.md
    Все проекты разрабатываются по единым правилам.
13. **Переключение проектов в боте** — команда `/project <name>` в Telegram-боте меняет рабочую директорию Claude CLI сессии owner:
    ```
    /project mybot        → cwd = /root/dev/mybot
    /project neuroforge  → cwd = /root/neuroforge
    ```
    Позволяет разрабатывать разные проекты из одного бота.
14. **Ресурсы сервера** — 2 CPU, 3.8 ГБ RAM, 79 ГБ диск. Ресурсы ограничены, поэтому общая инфра вместо изолированного стека на каждый проект. Нужен swap (4+ ГБ).
15. **Параллельные runs** — manager может вызвать `spawn_run()` несколько раз подряд для разных ролей. Runs попадают в очередь одновременно, воркеры обрабатывают их параллельно (лимит `MANAGER_MAX_CONCURRENT=3`). Manager запускается повторно после каждого завершившегося run и проверяет, все ли параллельные runs завершены, прежде чем двигать задачу дальше. Пример: manager спавнит reviewer-architecture + reviewer-business + reviewer-security → ждёт все 3 → затем спавнит tester.
16. **Рождение из mybot** — первая версия Нейроцеха создаётся на базе текущего проекта mybot (переиспользуем Claude CLI адаптер, DDD-структуру, память). Следующие проекты уже будут создаваться из Нейроцеха.
17. **Два PostgreSQL** — прод-бот (mybot) имеет свой PG, Нейроцех — свой. Полная изоляция: можно сносить/пересоздавать БД Нейроцеха без риска для прода.
18. **Минимальный внешний API** — эндпоинты делятся на две группы: управление проектами (POST/GET /projects) и управление задачами (POST /tasks, reply, cancel, GET). Всё остальное (сессии, шаги, роли, runs) — внутреннее дело Нейроцеха, не видно снаружи.
26. **Проект — обязательная сущность** — задача не может существовать без проекта. При регистрации проекта `repo_url` обязателен (любой git-репозиторий: GitHub, GitLab, Bitbucket, self-hosted). Нейроцех клонирует/обновляет репозиторий в `work_dir`. Нет проекта в реестре — нет задач.
29. **Bootstrap первого admin — CLI-команда** — bootstrapping problem решается через CLI на сервере:
    ```bash
    node cli.js create-admin --name "Саша"
    # → создаёт запись в users (role=admin), генерирует первый API-ключ, выводит его один раз
    ```
    Запускается один раз при первом деплое. После этого всё управление через API с полученным токеном. Последующие пользователи создаются через `POST /users` (только admin).
28. **Авторизация: Bearer API-ключи** — все запросы к API требуют `Authorization: Bearer <token>`. Токен выдаётся один раз и не хранится (хранится только SHA-256 хеш). Два типа субъектов: `users` (люди-администраторы, роли `admin`/`member`) и `api_keys` (сервисы: TG-бот, веб-хук и т.д.). Ключ можно ограничить одним проектом (`project_id`) — тогда он не увидит остальные.
27. **Нейроцех не знает о транспорте клиента** — никаких `chat_id`, `user_id`, `telegram_*` в схеме. Только `project_id` и непрозрачный `callbackMeta` JSONB. Клиент (TG-бот, веб-хук, CLI) сам решает что класть в `callbackMeta` и как интерпретировать при получении callback.
19. **Нейроцех умеет спрашивать** — callback type "question" блокирует задачу до получения ответа через POST /tasks/:id/reply. Нейроцех не гадает при неопределённости, а останавливается и спрашивает.
20. **Задачи в БД, не в файлах** — docs/task/ с файлами TASK.md/STATUS.md заменяется на таблицу tasks в PostgreSQL. Нейроцех — единственный источник правды о состоянии задач.
21. **Клиент не управляет пайплайном** — клиент ставит задачу текстом, Нейроцех сама решает какие роли задействовать, в каком порядке, сколько циклов review ↔ code. Клиент видит только progress/question/done/failed.
22. **MCP для коммуникации агентов с менеджером** — Нейроцех поднимает MCP-сервер с инструментами для агентов. Агенты вызывают инструменты вместо записи в stdout:
    - `report_progress(stage, message)` — отправить progress callback в процессе работы
    - `ask_question(question, context)` — задать вопрос и завершиться (задача → waiting_reply)
    - `complete(output)` — сообщить об успешном завершении шага
    Менеджер не парсит текст — получает структурированные вызовы. Агент подключается к MCP через `--mcp-config` при запуске `claude -p`.
23. **Завершение шага через MCP** — агент обязан завершить работу вызовом `complete()` или `ask_question()`. Если процесс завершился без вызова одного из них (crash, timeout) — менеджер помечает run как failed.
24. **Цикл review ↔ code ограничен** — поле `revision_count` в задаче. Лимит 5 итераций. На 6-й → task failed с сообщением "превышен лимит ревизий".
25. **Recovery зависших runs при рестарте** — при старте менеджер находит все runs со статусом `running` и помечает их как `interrupted`. Дальнейшее поведение зависит от роли:
    - **analyst, developer** — создаётся новый run для той же стадии с контекстом текущего состояния файлов (git diff, существующие артефакты). Агент продолжает с того места, где остановился.
    - **reviewer, tester** — чистый рестарт с нуля (обычный промпт без recovery-контекста), потому что их работа короткая и результат должен быть целостным.
    - Задачи в статусе `waiting_reply` (ждут ответа пользователя) — не трогать.
    - Recovery-промпт формируется функцией `getRestartPrompt(role, taskContext)`:
      - developer: "System restarted. Current git diff: {diff}. Continue implementation per spec."
      - analyst: "System restarted. Check existing files in {designDir} and continue analysis."
      - reviewer/tester: null (обычный промпт)

---

## Принятые решения (продолжение)

30. **Rate limits** — `MANAGER_MAX_CONCURRENT=3` (параллельные ревьюеры). Этот лимит покрывает и ограничения Anthropic API — не меняем.
31. **Git workflow агентов** — каждый агент в конце своей работы делает коммит в feature-ветку. Push только по подтверждению owner (`/push` команда в боте или явный запрос).
32. **Init — умный setup-агент, не шаблонизатор** — `neuroforge init` запускает специального setup-агента, который:
    1. Клонирует репозиторий (или принимает путь к существующему)
    2. Принимает **свободный бриф** от владельца — текстовое описание проекта, особенностей, деталей (`--brief "..."` или интерактивно через Telegram)
    3. Исследует кодовую базу (Glob, Read, Grep) — стек, архитектура, конвенции, тесты
    4. Задаёт **умные вопросы** через `ask_owner()` — только то, что непонятно из кода и не сказано в брифе (например: "Legacy-код в /api — намеренно или миграция?"). Фиксированной анкеты нет — вопросы генерируются динамически
    5. Генерирует `CLAUDE.md` и `.claude/agents/` под конкретный проект, не шаблон
    6. Коммитит конфиг в репозиторий
    7. Вызывает `complete()` — init завершён
    Для пустого репо — бриф обязателен (нечего анализировать). Для существующего — агент сначала читает код, потом спрашивает только о неясностях.

---

## Принятые решения (продолжение)

33. **AWAITING_INPUT — пауза агента для диалога с владельцем** — любой агент (не только setup) может остановиться и задать вопрос через MCP tool `ask_owner(questions: [])`. Пайплайн:
    ```
    INTAKE → ANALYZING → AWAITING_INPUT → ANALYZED → DEVELOPING → ...
    ```
    Механизм:
    1. Агент вызывает `ask_owner({ questions: [...] })` и завершается
    2. Нейроцех сохраняет вопросы в БД (поля `pending_questions`, `context_snapshot`), переводит задачу в `AWAITING_INPUT`
    3. Клиент получает callback `{ type: "question", ... }`, доставляет вопрос владельцу
    4. Владелец отвечает → `POST /tasks/:id/reply`
    5. Нейроцех восстанавливает контекст + добавляет ответы в промпт, запускает агент заново
    Агент не висит в памяти — всё персистировано. Работает для любого агента пайплайна.

34. **Тестирование проектов** — setup-агент при init прописывает в `CLAUDE.md` проекта стандартные команды тестирования (`npm test`, `pytest`, `go test`, `make test`). Tester-агент вызывает их через `Bash`. Нейроцех не знает о стеке — знает только команду из `CLAUDE.md`.
