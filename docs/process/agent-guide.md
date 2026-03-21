# Agent Guide

## Обзор

Система из 7 агентов обеспечивает полный цикл разработки. Teamlead оркестрирует процесс через Claude Code Teams (нативные инструменты).

## Агенты

### 1. Teamlead (оркестратор)
- **Файл:** `.claude/agents/teamlead.md`
- **Модель:** opus
- **Инструменты:** Все
- **Роль:** Управление задачами и пайплайном разработки

**Входы:**
- Запрос пользователя (создание задачи, запуск разработки)

**Выходы:**
- `docs/task/XXX/TASK.md` — описание задачи
- `docs/task/XXX/STATUS.md` — трекинг статуса
- Управление командой через Teams API

**Teams-протокол:**
| Действие | Инструмент |
|----------|-----------|
| Создание команды | `TeamCreate` |
| Запуск агентов | `Agent` с `team_name` |
| Создание подзадач | `TaskCreate` |
| Назначение | `TaskUpdate` с `owner` |
| Коммуникация | `SendMessage` |
| Мониторинг | `TaskList` |
| Завершение | `SendMessage(shutdown_request)` + `TeamDelete` |

---

### 2. Analyst (исследователь + проектировщик)
- **Файл:** `.claude/agents/analyst.md`
- **Модель:** opus
- **Инструменты:** Glob, Grep, Read, Write, Bash, WebFetch, WebSearch
- **Роль:** Research + Design (вызывается вручную пользователем)

**Режим RESEARCH:**
- Вход: `TASK.md` задачи
- Действия: исследование кодовой базы, внешних API, зависимостей
- Выход: `research/context.md`

**Режим DESIGN:**
- Вход: `TASK.md` + `research/context.md`
- Действия: проектирование решения, создание диаграмм
- Выход: `design/spec.md` с обязательными диаграммами:
  - **C4** — для архитектурных изменений
  - **Sequence** — для взаимодействия компонентов
  - **DFD/Flowchart** — для потоков данных

---

### 3. Developer (разработчик)
- **Файл:** `.claude/agents/developer.md`
- **Модель:** opus
- **Инструменты:** Все
- **Роль:** Реализация кода по спецификации

**Вход:** `TASK.md`, `design/spec.md` (если есть)
**Выход:** Код + тесты в `src/`

**Правила:**
- Следует DDD-структуре из `CLAUDE.md`
- Пишет тесты для каждого use case
- Сообщает teamlead по завершении через `SendMessage`

---

### 4. Reviewer-Architecture (архитектурный ревьюер)
- **Файл:** `.claude/agents/reviewer-architecture.md`
- **Модель:** sonnet
- **Инструменты:** Glob, Grep, Read, Write, Bash
- **Роль:** Проверка архитектурных решений

**Вход:** Код developer'а, `TASK.md`, `design/spec.md`
**Выход:** `review/review-architecture.md`

**Чеклист:**
- DDD-слои и dependency rule
- Порты и адаптеры
- Separation of concerns
- Naming conventions
- SOLID, DRY

---

### 5. Reviewer-Business (бизнес-ревьюер)
- **Файл:** `.claude/agents/reviewer-business.md`
- **Модель:** sonnet
- **Инструменты:** Glob, Grep, Read, Write, Bash
- **Роль:** Проверка бизнес-логики

**Вход:** Код developer'а, `TASK.md`, `design/spec.md`
**Выход:** `review/review-business.md`

**Чеклист:**
- Соответствие acceptance criteria
- Корректность бизнес-логики
- Edge cases
- Пользовательский опыт

---

### 6. Reviewer-Security (ревьюер безопасности)
- **Файл:** `.claude/agents/reviewer-security.md`
- **Модель:** sonnet
- **Инструменты:** Glob, Grep, Read, Write, Bash, WebSearch
- **Роль:** Проверка безопасности

**Вход:** Код developer'а
**Выход:** `review/review-security.md`

**Чеклист:**
- Инъекции (command, SQL, XSS)
- Утечка секретов
- Аутентификация/авторизация
- Валидация входных данных
- OWASP Top 10

---

### 7. Tester (тестировщик)
- **Файл:** `.claude/agents/tester.md`
- **Модель:** sonnet
- **Инструменты:** Glob, Grep, Read, Write, Bash
- **Роль:** Тестирование по acceptance criteria

**Вход:** Код developer'а, `TASK.md`, acceptance criteria
**Выход:** `review/test-report.md`

**Действия:**
- Запуск существующих тестов
- Написание дополнительных тестов при необходимости
- Проверка acceptance criteria
- Результат: PASS / FAIL с деталями

## Взаимодействие через Claude Code Teams

```
Teamlead (lead)
├── TeamCreate("task-XXX")
├── Agent → Developer (teammate)
│   ├── TaskCreate → задача
│   ├── TaskUpdate → owner: developer
│   └── Developer → SendMessage → "готово"
├── Agent × 3 → Reviewers (teammates, параллельно)
│   ├── reviewer-architecture
│   ├── reviewer-business
│   └── reviewer-security
├── Agent → Tester (teammate)
├── SendMessage(shutdown_request) → всем
└── TeamDelete
```
