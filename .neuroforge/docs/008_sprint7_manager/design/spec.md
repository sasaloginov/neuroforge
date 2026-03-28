# Sprint 7 — Manager + Worker + Composition Root: Design Spec

## 1. Worker (`src/infrastructure/scheduler/worker.js`)

### Ответственность

Worker — функция, которая забирает run из очереди и выполняет его. Один вызов `processOne()` обрабатывает ровно один run. Параллельность управляется снаружи (ManagerScheduler).

### API

```js
/**
 * @param {object} deps
 * @param {ProcessRun} deps.processRun — use case для выполнения run
 * @param {ManagerDecision} deps.managerDecision — use case для решения менеджера
 * @param {object} deps.logger — logger (info/warn/error)
 */
export function createWorker({ processRun, managerDecision, logger })

/**
 * Возвращаемый объект:
 * @returns {{ processOne: () => Promise<boolean> }}
 *   processOne() — обработать один run из очереди.
 *     Возвращает true если run был обработан, false если очередь пуста.
 */
```

### Алгоритм `processOne()`

```
1. result = await processRun.execute()
2. if (result === null) → return false  // очередь пуста
3. { run } = result
4. if (run.taskId) {
     try {
       await managerDecision.execute({ completedRunId: run.id })
     } catch (err) {
       logger.error('[Worker] ManagerDecision failed for run %s: %s', run.id, err.message)
       // НЕ бросаем — worker продолжает работу
     }
   }
5. return true
```

### Контракт

- Никогда не бросает исключений наружу (все ошибки ловятся и логируются)
- ProcessRun сам ловит ошибки выполнения run (fail/timeout) — worker получает `{ run, result }` даже при ошибке выполнения
- ManagerDecision вызывается только если run привязан к задаче (`taskId !== null`)
- Worker не знает о concurrency — это забота ManagerScheduler

### Обработка ошибок

| Ситуация | Поведение |
|---|---|
| ProcessRun.execute() бросает | Ловим, логируем error, return false |
| ManagerDecision.execute() бросает | Ловим, логируем error, return true (run обработан) |
| ProcessRun возвращает null | return false (очередь пуста) |
| ProcessRun возвращает { run } с status=failed/timeout | Всё равно вызываем ManagerDecision — менеджер решит что делать |

---

## 2. ManagerScheduler (`src/infrastructure/scheduler/managerScheduler.js`)

### Ответственность

Периодически проверяет очередь runs, запускает Worker для обработки, мониторит таймауты зависших runs, делает recovery при старте.

### API

```js
/**
 * @param {object} deps
 * @param {object} deps.worker — объект от createWorker() с методом processOne()
 * @param {PgRunRepo} deps.runRepo — для findRunning()
 * @param {RunService} deps.runService — для interrupt(), timeout()
 * @param {RoleRegistry} deps.roleRegistry — для получения timeoutMs роли
 * @param {object} deps.logger — logger (info/warn/error)
 * @param {object} deps.config
 * @param {number} deps.config.intervalMs — интервал тика (default 10000)
 * @param {number} deps.config.maxConcurrent — макс. параллельных обработок (default 3)
 * @param {boolean} deps.config.enabled — вкл/выкл (default true)
 */
export class ManagerScheduler {
  constructor(deps)

  /** Восстановить зависшие runs, запустить периодический тик. */
  async start()

  /** Остановить тик, дождаться завершения активных обработок. */
  async stop()
}
```

### Внутреннее состояние

```js
#intervalHandle = null    // ID от setInterval
#activeCount = 0          // сколько processOne() сейчас выполняются
#stopping = false         // флаг graceful shutdown
```

### Алгоритм `start()`

```
1. if (!config.enabled) → logger.info('disabled'), return
2. await recover()         // recovery зависших runs
3. #intervalHandle = setInterval(() => tick(), config.intervalMs)
4. logger.info('ManagerScheduler started (interval=%dms, maxConcurrent=%d)')
```

### Алгоритм `recover()`

```
1. runningRuns = await runRepo.findRunning()
2. for each run in runningRuns:
     await runService.interrupt(run.id)
     logger.warn('[Recovery] Run %s (role=%s) marked as interrupted', run.id, run.roleName)
3. if (runningRuns.length > 0)
     logger.info('[Recovery] Interrupted %d stale runs', runningRuns.length)
```

### Алгоритм `tick()`

```
1. if (#stopping) → return
2. await checkTimeouts()
3. // Запуск воркеров до заполнения слотов
   while (#activeCount < config.maxConcurrent && !#stopping) {
     #activeCount++
     // Не await — запускаем параллельно
     processSlot().then(() => { #activeCount-- })
     // Но первый processSlot нужно дождаться чтобы понять, есть ли runs
     // Решение: запускаем processSlot, он сам вернёт false если очередь пуста
   }
```

**Уточнение по параллельности в tick():**

tick() не должен бесконечно спавнить processSlot(). Логика:

```
async tick() {
  if (#stopping) return
  await checkTimeouts()

  // Заполняем свободные слоты
  const slotsAvailable = config.maxConcurrent - #activeCount
  for (let i = 0; i < slotsAvailable; i++) {
    #activeCount++
    this.#runSlot()  // fire-and-forget, уменьшает #activeCount по завершении
  }
}

async #runSlot() {
  try {
    // Обрабатываем runs пока очередь не опустеет
    while (!#stopping) {
      const processed = await worker.processOne()
      if (!processed) break  // очередь пуста
    }
  } catch (err) {
    logger.error('[Scheduler] Slot error: %s', err.message)
  } finally {
    #activeCount--
  }
}
```

Каждый слот работает как цикл: берёт run, обрабатывает, берёт следующий. Если очередь пуста — слот завершается. На следующем тике слоты запускаются заново.

### Алгоритм `checkTimeouts()`

```
1. runningRuns = await runRepo.findRunning()
2. const now = Date.now()
3. for each run in runningRuns:
     try {
       role = roleRegistry.get(run.roleName)
     } catch {
       continue  // роль не найдена — пропускаем
     }
     const elapsed = now - run.startedAt.getTime()
     if (elapsed > role.timeoutMs) {
       await runService.timeout(run.id)
       logger.warn('[Timeout] Run %s (role=%s) timed out after %dms', run.id, run.roleName, elapsed)
     }
```

### Алгоритм `stop()`

```
1. #stopping = true
2. if (#intervalHandle) clearInterval(#intervalHandle)
3. // Ждём завершения активных слотов (poll каждые 200ms, таймаут 30s)
   const deadline = Date.now() + 30_000
   while (#activeCount > 0 && Date.now() < deadline) {
     await sleep(200)
   }
4. if (#activeCount > 0)
     logger.warn('Force stopped with %d active slots', #activeCount)
5. logger.info('ManagerScheduler stopped')
```

### Защита от наложения тиков

`tick()` проверяет `#stopping`. Слоты, запущенные предыдущим тиком, продолжают работать — новый тик добавляет слоты только если есть свободные (`maxConcurrent - #activeCount`). Таким образом параллельность ограничена.

---

## 3. Composition Root (`src/index.js`)

### Ответственность

Единственное место DI. Создаёт все зависимости, связывает их, запускает сервер и планировщик, реализует graceful shutdown.

### Алгоритм запуска

```js
import 'dotenv/config';

import { createPool, closePool } from './infrastructure/persistence/pg.js';
import { loadRoles } from './infrastructure/roles/fileRoleLoader.js';
import { RoleRegistry } from './domain/services/RoleRegistry.js';
import { TaskService } from './domain/services/TaskService.js';
import { RunService } from './domain/services/RunService.js';
import { PgTaskRepo } from './infrastructure/persistence/PgTaskRepo.js';
import { PgRunRepo } from './infrastructure/persistence/PgRunRepo.js';
import { PgSessionRepo } from './infrastructure/persistence/PgSessionRepo.js';
import { PgProjectRepo } from './infrastructure/persistence/PgProjectRepo.js';
import { PgUserRepo } from './infrastructure/persistence/PgUserRepo.js';
import { PgApiKeyRepo } from './infrastructure/persistence/PgApiKeyRepo.js';
import { ClaudeCLIAdapter } from './infrastructure/claude/claudeCLIAdapter.js';
import { CallbackClient } from './infrastructure/callback/callbackClient.js';
import { CreateTask } from './application/CreateTask.js';
import { ProcessRun } from './application/ProcessRun.js';
import { ManagerDecision } from './application/ManagerDecision.js';
import { GetTaskStatus } from './application/GetTaskStatus.js';
import { CancelTask } from './application/CancelTask.js';
import { ReplyToQuestion } from './application/ReplyToQuestion.js';
import { createServer } from './infrastructure/http/server.js';
import { createWorker } from './infrastructure/scheduler/worker.js';
import { ManagerScheduler } from './infrastructure/scheduler/managerScheduler.js';

async function main() {
  // 1. Конфиг
  const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    databaseUrl: process.env.DATABASE_URL,
    rolesDir: process.env.ROLES_DIR || new URL('../roles', import.meta.url).pathname,
    workDir: process.env.WORK_DIR || process.cwd(),
    manager: {
      intervalMs: parseInt(process.env.MANAGER_INTERVAL_MS || '10000', 10),
      maxConcurrent: parseInt(process.env.MANAGER_MAX_CONCURRENT || '3', 10),
      enabled: process.env.MANAGER_ENABLED !== 'false',
    },
  };

  if (!config.databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  // 2. PG pool
  createPool(config.databaseUrl);

  // 3. Roles
  const roles = await loadRoles(config.rolesDir);
  const roleRegistry = new RoleRegistry();
  for (const role of roles) {
    roleRegistry.register(role);
  }
  console.log('[init] Loaded %d roles: %s', roles.length, roles.map(r => r.name).join(', '));

  // 4. Repos
  const taskRepo = new PgTaskRepo();
  const runRepo = new PgRunRepo();
  const sessionRepo = new PgSessionRepo();
  const projectRepo = new PgProjectRepo();
  const userRepo = new PgUserRepo();
  const apiKeyRepo = new PgApiKeyRepo();

  // 5. Adapters
  const chatEngine = new ClaudeCLIAdapter({ roleRegistry, workDir: config.workDir });
  const callbackSender = new CallbackClient();

  // 6. Domain services
  const taskService = new TaskService({ taskRepo });
  const runService = new RunService({ runRepo });

  // 7. Use cases
  const createTask = new CreateTask({ taskService, runService, roleRegistry, projectRepo, callbackSender });
  const processRun = new ProcessRun({ runRepo, runService, taskRepo, chatEngine, sessionRepo, roleRegistry, callbackSender });
  const managerDecision = new ManagerDecision({ runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo });
  const getTaskStatus = new GetTaskStatus({ taskRepo, runRepo });
  const cancelTask = new CancelTask({ taskService, callbackSender });
  const replyToQuestion = new ReplyToQuestion({ taskService, runService, roleRegistry, callbackSender });

  // 8. HTTP server
  const useCases = { createTask, getTaskStatus, cancelTask, replyToQuestion };
  const repos = { apiKeyRepo, userRepo, projectRepo, taskRepo, runRepo };
  const server = await createServer({ useCases, repos });

  // 9. Worker + Scheduler
  const worker = createWorker({ processRun, managerDecision, logger: console });
  const scheduler = new ManagerScheduler({
    worker,
    runRepo,
    runService,
    roleRegistry,
    logger: console,
    config: config.manager,
  });

  // 10. Graceful shutdown
  setupShutdown({ server, scheduler });

  // 11. Start
  await server.listen({ port: config.port, host: config.host });
  console.log('[init] Server listening on %s:%d', config.host, config.port);

  await scheduler.start();
}

function setupShutdown({ server, scheduler }) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[shutdown] Received %s, shutting down...', signal);

    try {
      // 1. Остановить scheduler (прекращает новые runs, ждёт активные)
      await scheduler.stop();
      console.log('[shutdown] Scheduler stopped');

      // 2. Закрыть HTTP-сервер (прекращает новые запросы, ждёт текущие)
      await server.close();
      console.log('[shutdown] Server closed');

      // 3. Закрыть PG pool
      await closePool();
      console.log('[shutdown] PG pool closed');

      process.exit(0);
    } catch (err) {
      console.error('[shutdown] Error:', err.message);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[init] Fatal:', err);
  process.exit(1);
});
```

### Конфигурация (ENV)

| Переменная | Default | Описание |
|---|---|---|
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `PORT` | 3000 | HTTP порт |
| `HOST` | 0.0.0.0 | HTTP хост |
| `ROLES_DIR` | `../roles` (relative to src/) | Директория с .md ролями |
| `WORK_DIR` | `process.cwd()` | Рабочая директория Claude CLI |
| `MANAGER_INTERVAL_MS` | 10000 | Интервал тика планировщика |
| `MANAGER_MAX_CONCURRENT` | 3 | Макс. параллельных runs |
| `MANAGER_ENABLED` | true | Включить/выключить планировщик |
| `LOG_LEVEL` | info | Уровень логирования Fastify |

---

## 4. Sequence Diagrams

### 4.1. Startup Sequence

```
main()
  │
  ├─ createPool(DATABASE_URL)
  │
  ├─ loadRoles(rolesDir)
  │   └─ roleRegistry.register(role) × N
  │
  ├─ new PgTaskRepo, PgRunRepo, PgSessionRepo, PgProjectRepo, PgUserRepo, PgApiKeyRepo
  │
  ├─ new ClaudeCLIAdapter({ roleRegistry, workDir })
  ├─ new CallbackClient()
  │
  ├─ new TaskService({ taskRepo })
  ├─ new RunService({ runRepo })
  │
  ├─ new CreateTask({ taskService, runService, roleRegistry, projectRepo, callbackSender })
  ├─ new ProcessRun({ runRepo, runService, taskRepo, chatEngine, sessionRepo, roleRegistry, callbackSender })
  ├─ new ManagerDecision({ runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo })
  ├─ new GetTaskStatus, CancelTask, ReplyToQuestion
  │
  ├─ createServer({ useCases, repos })
  ├─ createWorker({ processRun, managerDecision, logger })
  ├─ new ManagerScheduler({ worker, runRepo, runService, roleRegistry, config })
  │
  ├─ setupShutdown({ server, scheduler })
  │
  ├─ server.listen(port, host)
  │
  └─ scheduler.start()
        │
        ├─ recover()
        │   ├─ runRepo.findRunning()
        │   └─ runService.interrupt(runId) × N
        │
        └─ setInterval(tick, intervalMs)
```

### 4.2. Tick → Process Run → Manager Decision

```
setInterval tick()
  │
  ├─ checkTimeouts()
  │   ├─ runRepo.findRunning()
  │   └─ for each run where elapsed > role.timeoutMs:
  │       └─ runService.timeout(run.id)
  │
  └─ for each free slot (maxConcurrent - activeCount):
      └─ #runSlot()  [fire-and-forget]
          │
          └─ loop:
              │
              ├─ worker.processOne()
              │   │
              │   ├─ processRun.execute()
              │   │   ├─ runRepo.takeNext()        ← FOR UPDATE SKIP LOCKED
              │   │   │   (returns null → break loop)
              │   │   ├─ roleRegistry.get(roleName)
              │   │   ├─ sessionRepo.findByProjectAndRole()
              │   │   ├─ chatEngine.runPrompt()     ← claude -p (blocking, minutes)
              │   │   ├─ runService.complete(runId, response)
              │   │   └─ callbackSender.send()      ← progress callback
              │   │
              │   └─ managerDecision.execute({ completedRunId })
              │       ├─ runRepo.findById(completedRunId)
              │       ├─ taskService.getTask(taskId)
              │       ├─ runRepo.findByTaskId(taskId)
              │       ├─ check pending runs → if any, return { action: 'waiting' }
              │       ├─ chatEngine.runPrompt('manager', prompt)  ← manager agent
              │       ├─ parseManagerDecision(response)
              │       └─ switch action:
              │           ├─ spawn_run → runService.enqueue() + callback
              │           ├─ ask_owner → taskService.requestReply() + callback
              │           ├─ complete_task → taskService.completeTask() + callback
              │           └─ fail_task → taskService.failTask() + callback
              │
              └─ if processOne() returned false → break (queue empty)
```

### 4.3. Shutdown Sequence

```
SIGINT / SIGTERM
  │
  └─ shutdown(signal)
      │
      ├─ scheduler.stop()
      │   ├─ #stopping = true
      │   ├─ clearInterval(#intervalHandle)
      │   └─ poll until #activeCount === 0 (timeout 30s)
      │       │
      │       └─ active slots see #stopping → break out of loops
      │           └─ worker.processOne() finishes current run
      │               └─ managerDecision.execute() finishes
      │                   └─ slot exits, #activeCount--
      │
      ├─ server.close()
      │   └─ Fastify stops accepting new connections
      │   └─ Waits for in-flight requests to complete
      │
      └─ closePool()
          └─ pool.end()
              └─ All PG connections released
```

---

## 5. Component Diagram (index.js Wiring)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         src/index.js                                │
│                      (Composition Root)                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────────┐    │
│  │  PG Pool     │    │ FileRoleLoader│    │ ENV Config          │    │
│  │  (pg.js)     │    │ → RoleRegistry│    │                     │    │
│  └──────┬───────┘    └──────┬───────┘    └──────────┬──────────┘    │
│         │                   │                       │               │
│  ┌──────▼───────────────────▼───────────────────────▼──────────┐   │
│  │                     INFRASTRUCTURE                           │   │
│  │                                                              │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │   │
│  │  │ PgTaskRepo  │  │ PgRunRepo    │  │ PgSessionRepo     │  │   │
│  │  │ PgProjectRepo│ │ PgUserRepo   │  │ PgApiKeyRepo      │  │   │
│  │  └──────┬───────┘ └──────┬───────┘  └───────┬───────────┘  │   │
│  │         │                │                   │              │   │
│  │  ┌──────▼────┐    ┌──────▼──────┐                           │   │
│  │  │ClaudeCLI  │    │CallbackClient│                          │   │
│  │  │Adapter    │    │             │                            │   │
│  │  └──────┬────┘    └──────┬──────┘                           │   │
│  └─────────┼────────────────┼──────────────────────────────────┘   │
│            │                │                                       │
│  ┌─────────▼────────────────▼──────────────────────────────────┐   │
│  │                      DOMAIN SERVICES                         │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐       │   │
│  │  │ TaskService  │  │ RunService   │  │ RoleRegistry │       │   │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │   │
│  └─────────┼────────────────┼────────────────── ┼──────────────┘   │
│            │                │                   │                   │
│  ┌─────────▼────────────────▼───────────────────▼──────────────┐   │
│  │                      USE CASES                               │   │
│  │  ┌────────────┐  ┌────────────┐  ┌─────────────────┐       │   │
│  │  │ CreateTask  │  │ ProcessRun │  │ ManagerDecision │       │   │
│  │  │ GetStatus   │  │ CancelTask │  │ ReplyToQuestion │       │   │
│  │  └──────┬──────┘  └──────┬─────┘  └────────┬────────┘       │   │
│  └─────────┼────────────────┼─────────────────┼────────────────┘   │
│            │                │                 │                     │
│  ┌─────────▼────────┐  ┌───▼─────────────────▼─────────────┐      │
│  │   Fastify Server  │  │         ManagerScheduler           │      │
│  │   (HTTP routes)   │  │  ┌────────┐                        │      │
│  │                   │  │  │ Worker │ (processOne loop)      │      │
│  │   /health         │  │  └────────┘                        │      │
│  │   /tasks          │  │  tick → runSlot × maxConcurrent    │      │
│  │   /projects       │  │  checkTimeouts                     │      │
│  │   /admin          │  │  recover (on start)                │      │
│  └───────────────────┘  └────────────────────────────────────┘      │
│                                                                     │
│  setupShutdown: SIGINT/SIGTERM → scheduler.stop → server.close      │
│                                  → closePool                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Ключевые решения

### 6.1. Worker как функция, не класс

Worker — чистая фабричная функция `createWorker()`, возвращающая объект `{ processOne }`. Нет внутреннего состояния. Состояние (activeCount, stopping) живёт в ManagerScheduler. Это упрощает тестирование: mock processRun + managerDecision, вызвать processOne(), проверить результат.

### 6.2. Slot-based concurrency

Каждый слот — это цикл `while (!stopping) { processOne() }`. Количество слотов = `maxConcurrent`. Это лучше, чем запускать по одному run на тик, потому что:
- Длинный run (analyst, 5 мин) не блокирует остальные слоты
- Короткие runs (reviewer, 1 мин) обрабатываются быстро подряд
- `FOR UPDATE SKIP LOCKED` на уровне БД гарантирует, что два слота не возьмут один run

### 6.3. Recovery при старте

Recovery выполняется ДО запуска тика, синхронно. Все runs со статусом `running` помечаются как `interrupted`. Менеджер не пытается перезапустить их автоматически — это задача будущих тиков через ManagerDecision (если задача ещё актуальна).

### 6.4. Timeout monitoring vs. ProcessRun timeout

Два уровня таймаутов:
1. **ProcessRun** — `chatEngine.runPrompt()` имеет свой timeout, убивает процесс claude и помечает run как timeout
2. **ManagerScheduler.checkTimeouts()** — fallback. Если ProcessRun по какой-то причине не сработал (crash воркера, зависание), планировщик обнаружит зависший run и пометит timeout

### 6.5. Shutdown order

1. **Scheduler** первым — перестаёт брать новые runs, ждёт завершения текущих
2. **Server** вторым — перестаёт принимать HTTP, ждёт in-flight запросы
3. **PG pool** последним — после того как все consumers отпустили соединения

Scheduler первым потому что он долго работающий (run может длиться минуты). Server закрывается быстро (HTTP-запросы секунды). Если закрыть pool раньше scheduler — текущие runs упадут с ошибкой БД.

---

## 7. Test Plan

### 7.1. Worker Tests (`src/infrastructure/scheduler/worker.test.js`)

#### TC-W1: Обработка run + вызов ManagerDecision
- **Setup:** mock processRun.execute() возвращает `{ run: { id: '1', taskId: 't1' }, result: {} }`; mock managerDecision.execute()
- **Act:** `await worker.processOne()`
- **Assert:** processRun.execute() вызван 1 раз; managerDecision.execute({ completedRunId: '1' }) вызван 1 раз; return true

#### TC-W2: Пустая очередь
- **Setup:** mock processRun.execute() возвращает null
- **Act:** `const result = await worker.processOne()`
- **Assert:** result === false; managerDecision.execute() НЕ вызван

#### TC-W3: Run без taskId (skip ManagerDecision)
- **Setup:** mock processRun.execute() возвращает `{ run: { id: '1', taskId: null }, result: {} }`
- **Act:** `await worker.processOne()`
- **Assert:** managerDecision.execute() НЕ вызван; return true

#### TC-W4: ManagerDecision бросает ошибку
- **Setup:** mock processRun.execute() возвращает `{ run: { id: '1', taskId: 't1' } }`; mock managerDecision.execute() throws Error
- **Act:** `const result = await worker.processOne()`
- **Assert:** result === true (run обработан); ошибка залогирована; НЕ бросает

#### TC-W5: ProcessRun бросает ошибку
- **Setup:** mock processRun.execute() throws Error
- **Act:** `const result = await worker.processOne()`
- **Assert:** result === false; ошибка залогирована; НЕ бросает

### 7.2. ManagerScheduler Tests (`src/infrastructure/scheduler/managerScheduler.test.js`)

#### TC-S1: start() → recover() вызывается
- **Setup:** mock runRepo.findRunning() returns 2 runs; mock runService.interrupt()
- **Act:** `await scheduler.start()`
- **Assert:** runService.interrupt() вызван 2 раза; setInterval установлен

#### TC-S2: start() с enabled=false
- **Setup:** config.enabled = false
- **Act:** `await scheduler.start()`
- **Assert:** recover() НЕ вызван; setInterval НЕ установлен

#### TC-S3: tick() запускает слоты
- **Setup:** maxConcurrent=2; mock worker.processOne() возвращает true, потом false
- **Act:** вызвать tick() вручную
- **Assert:** worker.processOne() вызван; activeCount корректно отслеживается

#### TC-S4: checkTimeouts() находит зависший run
- **Setup:** mock runRepo.findRunning() returns [{ id: '1', roleName: 'analyst', startedAt: new Date(Date.now() - 600000) }]; role.timeoutMs = 300000
- **Act:** вызвать checkTimeouts()
- **Assert:** runService.timeout('1') вызван

#### TC-S5: checkTimeouts() не трогает свежий run
- **Setup:** run.startedAt = Date.now() - 1000; role.timeoutMs = 300000
- **Act:** вызвать checkTimeouts()
- **Assert:** runService.timeout() НЕ вызван

#### TC-S6: stop() ждёт активные слоты
- **Setup:** scheduler запущен, activeCount > 0
- **Act:** `await scheduler.stop()`
- **Assert:** clearInterval вызван; функция ждёт пока activeCount === 0

#### TC-S7: stop() с форсированным таймаутом
- **Setup:** activeCount > 0, слот зависает
- **Act:** `await scheduler.stop()`
- **Assert:** через 30s stop() завершается с warn-логом

#### TC-S8: tick() не запускает слоты если stopping=true
- **Setup:** `#stopping = true`
- **Act:** вызвать tick()
- **Assert:** worker.processOne() НЕ вызван

### 7.3. Integration Tests (manual / e2e)

#### TC-I1: Full pipeline
1. POST /tasks → задача создана, run analyst в очереди
2. Scheduler tick → worker берёт run, выполняет через claude CLI
3. ManagerDecision → спавнит следующий run (developer)
4. Worker обрабатывает developer run
5. ManagerDecision → complete_task
6. Callback приходит с type=done

#### TC-I2: Graceful shutdown
1. Запустить сервер с run в процессе выполнения
2. Послать SIGTERM
3. Убедиться: текущий run завершается, сервер закрывается корректно, pool закрыт

#### TC-I3: Recovery
1. Вручную создать run со status=running в БД
2. Запустить сервер
3. Убедиться: run помечен как interrupted

---

## 8. Файлы к созданию/изменению

| Файл | Действие | Описание |
|---|---|---|
| `src/infrastructure/scheduler/worker.js` | Создать | Функция createWorker |
| `src/infrastructure/scheduler/worker.test.js` | Создать | Unit-тесты worker |
| `src/infrastructure/scheduler/managerScheduler.js` | Создать | Класс ManagerScheduler |
| `src/infrastructure/scheduler/managerScheduler.test.js` | Создать | Unit-тесты scheduler |
| `src/index.js` | Создать | Composition Root |
| `package.json` | Изменить | Добавить `"start": "node src/index.js"`, зависимость `dotenv` |

---

## 9. Зависимости (npm)

| Пакет | Версия | Назначение |
|---|---|---|
| `dotenv` | ^16.x | Загрузка ENV из .env файла |

Все остальные зависимости (fastify, pg, yaml) уже установлены.
