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
  // 1. Config
  const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    databaseUrl: process.env.DATABASE_URL,
    rolesDir: process.env.ROLES_DIR || new URL('../roles', import.meta.url).pathname,
    workDir: process.env.WORKSPACE_DIR || process.cwd(),
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
  const getTaskStatus = new GetTaskStatus({ taskService, runRepo });
  const cancelTask = new CancelTask({ taskService, runRepo, callbackSender });
  const replyToQuestion = new ReplyToQuestion({ taskService, runService, runRepo, callbackSender });

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
      // 1. Stop scheduler (stops new runs, waits for active ones)
      await scheduler.stop();
      console.log('[shutdown] Scheduler stopped');

      // 2. Close HTTP server (stops new requests, waits for in-flight)
      await server.close();
      console.log('[shutdown] Server closed');

      // 3. Close PG pool
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
