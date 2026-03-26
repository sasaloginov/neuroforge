# NF-25: Research — Resume API Refactoring

## Текущее состояние

### Эндпоинты управления задачами
| Метод | Путь | Use Case | Статус |
|-------|------|----------|--------|
| POST | /tasks/:id/resume | ResumeResearch | Только research_done |
| POST | /tasks/:id/restart | RestartTask | Только failed |
| POST | /tasks/:id/enqueue | EnqueueTask | Только backlog |

### Проблемы
1. **`/resume` слишком узкий** — работает только из `research_done`, нет возможности возобновить `failed`, `needs_escalation`, `cancelled` задачи универсально.
2. **`/restart` перекрывается** — RestartTask по сути делает то же что нужный универсальный resume: смотрит историю ранов и через ManagerDecision определяет следующий шаг. Но работает только из `failed`.
3. **`/enqueue` не поддерживает mode** — нельзя сменить mode при переводе из backlog в pending.
4. **Именование `/resume` вводит в заблуждение** — название подразумевает общий resume, но на деле это узкоспециализированный resume-research.

### Затрагиваемые статусы и переходы

Текущая таблица переходов (Task.js TRANSITIONS):
```
cancelled → [] (пустой!)
failed → [in_progress]
needs_escalation → [in_progress, cancelled]
research_done → [in_progress, cancelled]
```

**Проблема**: `cancelled → in_progress` отсутствует. Для универсального resume из `cancelled` нужно добавить этот переход.

### Анализ RestartTask vs ResumeTask

RestartTask уже содержит 90% логики нового ResumeTask:
- Берёт историю ранов
- Если нет ранов → стартует analyst
- Если есть → вызывает ManagerDecision с последним раном
- Делает callback

Отличия нового ResumeTask:
- Допускает 3 статуса: failed, needs_escalation, cancelled (не один)
- Поддерживает опциональную instruction
- Использует `activateIfNoActive` для атомарного активирования (как ResumeResearch)

### Зависимости
- `src/index.js` — composition root, нужно добавить DI для нового ResumeTask и обновить useCases
- `src/infrastructure/http/routes/taskRoutes.js` — новый маршрут + переименование
- `src/application/EnqueueTask.js` — добавить mode
- `src/domain/entities/Task.js` — добавить transition cancelled→in_progress
- `src/domain/services/TaskService.js` — возможно новый метод для resume

### Риски
1. **Breaking change** — переименование `/resume` → `/resume-research` сломает клиентов (TG-бот). Нужно координировать с клиентским кодом.
2. **Cancelled → in_progress** — допуск этого перехода может привести к повторному запуску задач, которые были отменены намеренно. Это ожидаемое поведение по задаче, но стоит отметить.
3. **RestartTask устаревает** — новый ResumeTask покрывает функционал RestartTask. Нужно решить: удалять или оставлять для обратной совместимости.

### ADR: Судьба RestartTask

**Решение**: Оставить RestartTask как есть. ResumeTask — новый use case с расширенной логикой. Не трогаем работающий код без необходимости. В будущем RestartTask может быть deprecated.

**Обоснование**:
- RestartTask работает, клиенты его используют
- ResumeTask покрывает больше статусов, но имеет другую семантику (instruction, cancelled)
- Удаление RestartTask — отдельная задача, выходящая за scope NF-25
