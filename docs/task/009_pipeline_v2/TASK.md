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
- CTO — это `git merge`, не нужен LLM
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
- **Начинает с git diff**, а не с обхода проекта
- PM передаёт: diff, список изменённых файлов, context.md, acceptance criteria
- Если diff пустой — сразу PASS (не тратит токены на чтение)
- При re-review: `--resume` к той же сессии, видит предыдущие findings

### Убираемые роли
- **tester** — developer и так пишет/запускает тесты
- **cto** — заменяется детерминистическим шагом: `git checkout main && git merge --no-ff <branch> && git push`

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
 ├─ запускает reviewer (sonnet, new session, получает diff)
 │   └─ architecture + business + security review
 ├─ получает результат reviewer'а
 ├─ если findings:
 │   ├─ формирует fix prompt с конкретными замечаниями
 │   ├─ запускает developer (opus, --resume)
 │   ├─ запускает reviewer (sonnet, --resume, новый diff)
 │   └─ макс 3 итерации → escalation
 ├─ если PASS:
 │   ├─ git merge --no-ff + push (детерминистический шаг)
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
- [ ] Reviewer получает `git diff` как часть промпта от PM
- [ ] Если diff пустой — PASS без чтения кода
- [ ] Объединённый чеклист: DDD/SOLID + AC coverage + OWASP
- [ ] При re-review: `--resume` к сессии reviewer'а
- [ ] Формат ответа: тот же (VERDICT + FINDINGS + SUMMARY)

### Merge как скрипт
- [ ] `git checkout main && git merge --no-ff <branch> && git push` — без LLM
- [ ] При merge conflict — task escalation (не автоматическое разрешение)
- [ ] Удаление feature-ветки после успешного merge

### Убрать tester и cto
- [ ] Роль tester удалена из roles/ и RoleRegistry
- [ ] Роль cto удалена из roles/ и RoleRegistry
- [ ] Developer role definition включает: "Напиши тесты, запусти, убедись что проходят"
- [ ] Все существующие тесты проходят без tester/cto ролей

### Обратная совместимость
- [ ] API POST /tasks не меняется (те же параметры)
- [ ] Callbacks работают (progress, done, failed, needs_escalation)
- [ ] Research mode работает (analyst only → research_done)
- [ ] Cancel task работает (abort running sessions)
- [ ] Restart task работает

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
  - Новый `MergeStep.js` — детерминистический merge без LLM

- Infrastructure:
  - `claudeCLIAdapter.js` — без изменений (--resume уже работает)
  - `PgSessionRepo.js` — session per task+role вместо project+role
  - `managerScheduler.js` — адаптировать под PM-модель
  - `worker.js` — адаптировать chain: ProcessRun → PM resume

- Roles:
  - Новый `roles/pm.md` — PM-оркестратор
  - Обновить `roles/analyst.md` — убрать создание ветки (делает PM)
  - Обновить `roles/developer.md` — добавить тестирование
  - Новый `roles/reviewer.md` — unified чеклист
  - Удалить `roles/tester.md`, `roles/cto.md`
  - Удалить `roles/reviewer-architecture.md`, `roles/reviewer-business.md`, `roles/reviewer-security.md`

## Ограничения и риски

| Риск | Вероятность | Митигация |
|------|------------|-----------|
| PM-сессия растёт до compaction, теряет контекст | Средняя | PM на sonnet (200K окно), типичная задача ~30K. Запас большой |
| Developer resume после analyst — слишком длинный контекст | Средняя | Compaction CLI сожмёт автоматически. Context.md как fallback |
| Unified reviewer пропускает что ловили 3 отдельных | Средняя | Объединённый чеклист покрывает все 3 области. Sonnet справляется |
| --resume к несуществующей сессии | Низкая | ClaudeCLIAdapter уже обрабатывает StaleSessionError → retry без resume |
| Merge conflict при автоматическом merge | Низкая | Escalation + callback, не автоматическое разрешение |

## Definition of Done
- [ ] Пайплайн: PM → analyst → developer (resume) → reviewer → merge (скрипт)
- [ ] 3 сессии на задачу вместо 7-8 процессов
- [ ] Все существующие тесты проходят
- [ ] E2E: задача проходит полный цикл через новый пайплайн
- [ ] Стоимость типичной задачи ≤ $3-4
