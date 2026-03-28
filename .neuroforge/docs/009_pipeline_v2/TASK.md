# Task NF-21: Pipeline v2 — session-based агенты с PM-оркестратором

## Тип
refactoring

## Приоритет
high

## Описание

Рефакторинг агентного пайплайна для сокращения потребления токенов в 2-3 раза без потери качества.

### Проблема

Текущий пайплайн (7-8 агентов, каждый стартует с чистого контекста):
- Каждый агент заново обходит кодовую базу через Read/Glob/Grep
- Manager LLM вызывается stateless между каждым шагом, дублируя всю историю
- 3 reviewer'а параллельно строят один и тот же контекст
- Tester дублирует работу developer'а (тесты)
- CTO — это `git merge`, отдельный LLM-агент для этого избыточен
- Стоимость типичной задачи: **$7-8** при целевых **$2-3**

### Решение

**3 сессии на задачу** вместо 7-8 изолированных процессов:

#### Сессия 1: PM (sonnet)
- **Первый запускается**, живёт на протяжении всей задачи
- Каждый вызов — `--resume` к той же сессии (накапливает контекст)
- Получает результат каждого шага в промпте (только дельту, не всю историю)
- Формирует rich prompt для следующего агента (с конкретным кодом, файлами, инструкциями)
- Создаёт git-ветку (не analyst)
- Принимает решения: следующий шаг, retry, ask_owner, complete, fail
- Не вызывает LLM для детерминистических решений (analyst done → запустить developer)

#### Сессия 2: Implementer (opus) — analyst + developer
- **Analyst фаза**: исследует проект, создаёт research, spec, context.md, коммитит
- **Developer фаза**: `--resume` к сессии analyst'а. PM добавляет фокусирующий промпт: "Теперь реализуй по спецификации. Сфокусируйся на коде."
- Developer видит весь контекст analyst'а (прочитанные файлы, архитектура, решения) — **не перечитывает ничего**
- Пишет код + тесты + коммитит
- При revision (fix после review): снова `--resume`, PM передаёт конкретные замечания

#### Сессия 3: Reviewer (sonnet)
- **Один reviewer** вместо трёх, объединённый чеклист (architecture + business + security)
- **Сам берёт `git diff`** из репозитория (developer коммитит перед ревью)
- Начинает с анализа diff — что изменилось, потом углубляется в нужные файлы
- Если diff пустой — сразу PASS (не тратит токены на чтение)
- При re-review: `--resume` к той же сессии, видит предыдущие findings

### Убираемые роли
- **tester** — developer и так пишет/запускает тесты
- **cto** — merge делает PM после успешного ревью (PM имеет доступ к Bash)

### Новый пайплайн
```
PM (sonnet, --resume)
 ├─ создаёт ветку
 ├─ запускает analyst (opus, new session)
 │   └─ research + spec + context.md + commit
 ├─ получает результат analyst'а
 ├─ запускает developer (opus, --resume analyst session)
 │   └─ код + тесты + commit
 ├─ получает результат developer'а
 ├─ запускает reviewer (sonnet, new session)
 │   └─ сам берёт git diff, ревью: architecture + business + security
 ├─ получает результат reviewer'а
 ├─ если findings:
 │   ├─ формирует fix prompt с конкретными замечаниями
 │   ├─ запускает developer (opus, --resume)
 │   ├─ запускает reviewer (sonnet, --resume)
 │   └─ макс 3 итерации → escalation
 ├─ если PASS:
 │   ├─ PM делает merge + push (через Bash)
 │   └─ complete task
 └─ callback на каждом шаге
```

## Acceptance Criteria

### PM-оркестратор
- [ ] PM запускается первым при создании задачи
- [ ] PM использует `--resume` для сохранения контекста между шагами
- [ ] PM получает только дельту (результат последнего шага), не всю историю
- [ ] PM формирует rich prompt для каждого агента (с конкретным кодом, путями, инструкциями)
- [ ] PM создаёт git-ветку задачи (не analyst)
- [ ] PM детерминистически продвигает пайплайн (analyst → developer → reviewer → merge) без LLM для стандартных переходов

### Session sharing: analyst → developer
- [ ] Developer запускается с `--resume` сессии analyst'а
- [ ] PM добавляет фокусирующий промпт при resume ("Переключись на реализацию...")
- [ ] Developer видит контекст analyst'а без повторного чтения файлов
- [ ] При revision cycle developer снова `--resume` к той же сессии

### Unified reviewer
- [ ] Один reviewer вместо трёх (architecture + business + security)
- [ ] Reviewer сам делает `git diff main..HEAD` для анализа изменений
- [ ] Начинает с diff, углубляется в файлы по необходимости
- [ ] Если diff пустой — сразу PASS без чтения кода
- [ ] Объединённый чеклист: DDD/SOLID + AC coverage + OWASP
- [ ] При re-review: `--resume` к сессии reviewer'а
- [ ] Формат ответа: тот же (VERDICT + FINDINGS + SUMMARY)

### Merge через PM
- [ ] После PASS от reviewer'а PM делает merge + push через Bash
- [ ] При merge conflict — task escalation (не автоматическое разрешение)
- [ ] Удаление feature-ветки после успешного merge

### Роли tester и cto
- [ ] Роли tester и cto НЕ удаляются из roles/, файлы остаются
- [ ] Роли не регистрируются в пайплайне v2 (PM их не запускает)
- [ ] Developer role definition включает: "Напиши тесты, запусти, убедись что проходят"
- [ ] Старые роли reviewer-architecture/business/security тоже остаются в roles/

### Обратная совместимость и сохранение логики

Рефакторинг затрагивает ТОЛЬКО пайплайн (кто запускается, как передаётся контекст). Вся бизнес-логика, API, фичи — сохраняются без изменений:

**API и callbacks:**
- [ ] API POST /tasks не меняется (те же параметры)
- [ ] Callbacks работают: progress, done, failed, needs_escalation, question, tech_debt, research_done
- [ ] Callback meta сохраняется на протяжении всего пайплайна

**Режимы задач:**
- [ ] Research mode: analyst only → research_done → resume → developer (mode переключается на full)
- [ ] Auto/Full mode: полный пайплайн PM → analyst → developer → reviewer → merge
- [ ] Валидация mode через isValidMode() (TaskMode value object)

**Управление задачами:**
- [ ] Cancel task: abort running sessions через RunAbortRegistry
- [ ] Restart task: failed → in_progress, PM решает с какого шага продолжить
- [ ] Reply to question: PM получает ответ владельца, возобновляет пайплайн
- [ ] Task queue: один активный таск на проект, остальные pending (activateOldestPending)

**Revision cycle:**
- [ ] Reviewer findings парсятся через ReviewFindings (VERDICT + FINDINGS + SUMMARY)
- [ ] Все findings кроме LOW передаются developer'у (CRITICAL → MINOR)
- [ ] Developer fix → re-review (последовательно, не одновременно)
- [ ] Макс 3 ревизии → escalation (needs_escalation)

**Git:**
- [ ] Ветка создаётся PM при старте задачи (generateBranchName)
- [ ] Analyst коммитит research + spec + context.md
- [ ] Developer коммитит код + тесты
- [ ] Worktree sync для agent worktrees (syncAllWorktrees)

**Артефакты analyst'а:**
- [ ] research/<shortId>_<slug>.md — исследование
- [ ] design/spec.md — спецификация
- [ ] context.md — карта затрагиваемого кода (макс 150 строк)
- [ ] PROJECT_MAP.md — обновляется если затронуты новые модули

**Session management:**
- [ ] Session per task+role (не project+role как сейчас)
- [ ] cliSessionId сохраняется для --resume
- [ ] StaleSessionError → retry без resume (уже реализовано)

**Метрики:**
- [ ] usage (input/output tokens, cache_read, cache_create, cost_usd) для каждого run
- [ ] Сохраняется в runs.usage (jsonb)

### Метрики
- [ ] usage (tokens, cost) сохраняется для каждого run
- [ ] Стоимость задачи ≤ $3-4 (vs текущие $7-8) для типичной задачи

## Контекст

- Текущая архитектура: `src/application/ManagerDecision.js`, `src/application/ProcessRun.js`
- Session management: `src/infrastructure/persistence/PgSessionRepo.js`, `src/domain/entities/Session.js`
- CLI adapter: `src/infrastructure/claude/claudeCLIAdapter.js` (уже поддерживает `--resume`)
- Research по оптимизации токенов: ветка `research/task-scoped-memory`
- Текущие метрики NF-20: analyst $1.84, developer $2.69, reviewer×3 ~$1.74, revision cycles ~$1.5

## Затрагиваемые компоненты

- Domain:
  - `Session.js` — добавить привязку к taskId (сейчас per project+role)
  - `Run.js` — без изменений
  - `ReviewFindings.js` — без изменений (unified reviewer использует тот же формат)

- Application:
  - `ManagerDecision.js` — **переписать**: stateless → stateful PM через --resume
  - `ProcessRun.js` — **изменить**: поддержка session sharing (analyst → developer)
  - Убрать `MergeStep` — PM делает merge сам

- Infrastructure:
  - `claudeCLIAdapter.js` — без изменений (--resume уже работает)
  - `PgSessionRepo.js` — session per task+role вместо project+role
  - `managerScheduler.js` — адаптировать под PM-модель
  - `worker.js` — адаптировать chain: ProcessRun → PM resume

- Roles:
  - Новый `roles/pm.md` — PM-оркестратор
  - Обновить `roles/analyst.md` — убрать создание ветки (делает PM)
  - Обновить `roles/developer.md` — добавить тестирование
  - Новый `roles/reviewer.md` — unified чеклист (architecture + business + security)
  - `roles/tester.md`, `roles/cto.md` — НЕ удалять, оставить как есть (не регистрируются в пайплайне, но сохраняются на случай возврата)
  - `roles/reviewer-architecture.md`, `roles/reviewer-business.md`, `roles/reviewer-security.md` — НЕ удалять, оставить как есть

## Ограничения и риски

| Риск | Вероятность | Митигация |
|------|------------|-----------|
| PM-сессия растёт до compaction, теряет контекст | Средняя | PM на sonnet (200K окно), типичная задача ~30K. Запас большой |
| Developer resume после analyst — слишком длинный контекст | Средняя | Compaction CLI сожмёт автоматически. Context.md как fallback |
| Unified reviewer пропускает что ловили 3 отдельных | Средняя | Объединённый чеклист покрывает все 3 области. Sonnet справляется |
| --resume к несуществующей сессии | Низкая | ClaudeCLIAdapter уже обрабатывает StaleSessionError → retry без resume |
| Merge conflict при автоматическом merge | Низкая | Escalation + callback, не автоматическое разрешение |

## Definition of Done
- [ ] Пайплайн: PM → analyst → developer (resume) → reviewer → PM merge
- [ ] 3 сессии на задачу вместо 7-8 процессов
- [ ] Все существующие тесты проходят
- [ ] E2E: задача проходит полный цикл через новый пайплайн
- [ ] Стоимость типичной задачи ≤ $3-4
