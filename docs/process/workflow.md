# Development Workflow

## Обзор процесса

Система агентов обеспечивает повторяемый процесс разработки: от создания задачи до готового кода.

```mermaid
flowchart TD
    U[Пользователь] -->|"создай задачу"| TL[Teamlead]
    TL -->|"TASK.md + STATUS.md"| INTAKE[INTAKE]
    INTAKE -->|"опционально"| AN[Analyst]
    AN -->|"research/context.md"| RESEARCH[ANALYZING]
    RESEARCH -->|"design/spec.md"| DESIGN[ANALYZED]
    DESIGN -->|"отправь на разработку"| TL2[Teamlead]
    TL2 -->|"TeamCreate + Agent"| DEV[Developer]
    DEV -->|"код + тесты"| DEVELOPED[DEVELOPED]
    DEVELOPED -->|"Agent × 3"| REV[Reviewers ×3]
    REV -->|"PASS"| REVIEWED[REVIEWED]
    REV -->|"FAIL"| DEV
    REVIEWED -->|"Agent"| TEST[Tester]
    TEST -->|"PASS"| DONE[DONE]
    TEST -->|"FAIL"| DEV

    style TL fill:#4a90d9,color:#fff
    style AN fill:#17a2b8,color:#fff
    style DEV fill:#28a745,color:#fff
    style REV fill:#ffc107,color:#000
    style TEST fill:#17a2b8,color:#fff
    style DONE fill:#28a745,color:#fff
```

## Шаги процесса

### Шаг 1: Создание задачи (ручной)
**Кто:** Пользователь → Teamlead
**Что:**
1. Teamlead классифицирует задачу (feature / bugfix / refactoring)
2. Создаёт структуру `docs/task/XXX_short_name/`
3. Заполняет `TASK.md` и `STATUS.md`
4. Статус: **INTAKE**
5. **СТОП** — ждёт пользователя

### Шаг 2: Анализ (ручной, опциональный)
**Кто:** Пользователь → Analyst
**Режим RESEARCH:**
1. Исследует кодовую базу (Glob, Grep, Read)
2. Исследует внешние API/библиотеки (WebSearch, WebFetch)
3. Результат: `research/context.md`
4. Статус: **ANALYZING**

**Режим DESIGN:**
1. Проектирует решение на основе research
2. Создаёт диаграммы (Mermaid): C4, Sequence, DFD
3. Результат: `design/spec.md`
4. Статус: **ANALYZED**

### Шаг 3: Разработка (автоматический пайплайн)
**Кто:** Пользователь → Teamlead → автопайплайн

```mermaid
sequenceDiagram
    actor User
    participant TL as Teamlead
    participant Dev as Developer
    participant RA as Reviewer-Arch
    participant RB as Reviewer-Biz
    participant RS as Reviewer-Sec
    participant T as Tester

    User->>TL: "отправь задачу XXX на разработку"
    TL->>TL: TeamCreate("task-XXX")
    TL->>Dev: Agent(team_name: "task-XXX")
    TL->>Dev: TaskCreate + TaskUpdate(owner: dev)

    Dev->>Dev: Читает TASK.md, spec.md
    Dev->>Dev: Пишет код + тесты
    Dev->>TL: SendMessage("код готов")

    par Параллельное ревью
        TL->>RA: Agent(team_name: "task-XXX")
        TL->>RB: Agent(team_name: "task-XXX")
        TL->>RS: Agent(team_name: "task-XXX")
    end

    RA->>TL: SendMessage(result)
    RB->>TL: SendMessage(result)
    RS->>TL: SendMessage(result)

    alt Все PASS
        TL->>T: Agent(team_name: "task-XXX")
        T->>TL: SendMessage(result)
        alt PASS
            TL->>TL: STATUS = DONE
        else FAIL
            TL->>Dev: SendMessage("fix tests")
            Dev->>TL: SendMessage("fixed")
            Note over TL: Повтор ревью
        end
    else Есть FAIL
        TL->>Dev: SendMessage("fix issues")
        Dev->>TL: SendMessage("fixed")
        Note over TL: Повтор ревью
    end

    TL->>TL: shutdown_request → всем
    TL->>TL: TeamDelete
```

## Статусы задачи

```mermaid
stateDiagram-v2
    [*] --> INTAKE
    INTAKE --> ANALYZING: analyst начал research
    ANALYZING --> ANALYZED: analyst завершил design
    INTAKE --> DEVELOPING: пропуск анализа
    ANALYZED --> DEVELOPING: teamlead запустил пайплайн
    DEVELOPING --> DEVELOPED: developer закончил
    DEVELOPED --> REVIEWING: ревьюеры запущены
    REVIEWING --> REVIEWED: все PASS
    REVIEWING --> REVIEW_FAILED: есть FAIL
    REVIEW_FAILED --> DEVELOPING: developer исправляет
    REVIEWED --> TESTING: тестер запущен
    TESTING --> TESTED: PASS
    TESTING --> TEST_FAILED: FAIL
    TEST_FAILED --> DEVELOPING: developer исправляет
    TESTED --> DONE
```

## Структура папки задачи

```
docs/task/XXX_short_name/
├── TASK.md              # Требования, acceptance criteria
├── STATUS.md            # Текущий статус и история
├── research/            # Результаты analyst (режим research)
│   └── context.md
├── design/              # Проектирование (режим design)
│   └── spec.md
├── adr/                 # Architecture Decision Records
├── review/              # Результаты ревью
│   ├── review-architecture.md
│   ├── review-business.md
│   ├── review-security.md
│   └── test-report.md
└── docs/                # Пользовательская документация
```
