import 'dotenv/config';
import { readFile, writeFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
import { startMcpHttpServer } from './infrastructure/mcp/mcpServer.js';
import { CreateTask } from './application/CreateTask.js';
import { ProcessRun } from './application/ProcessRun.js';
import { ManagerDecision } from './application/ManagerDecision.js';
import { GetTaskStatus } from './application/GetTaskStatus.js';
import { GetRunDetail } from './application/GetRunDetail.js';
import { CancelTask } from './application/CancelTask.js';
import { ReplyToQuestion } from './application/ReplyToQuestion.js';
import { RestartTask } from './application/RestartTask.js';
import { EnqueueTask } from './application/EnqueueTask.js';
import { ResumeResearch } from './application/ResumeResearch.js';
import { ReviseAnalysis } from './application/ReviseAnalysis.js';
import { StartNextPendingTask } from './application/StartNextPendingTask.js';
import { RunAbortRegistry } from './application/RunAbortRegistry.js';
import { GitCLIAdapter } from './infrastructure/git/gitCLIAdapter.js';
import { createServer } from './infrastructure/http/server.js';
import { createWorker } from './infrastructure/scheduler/worker.js';
import { ManagerScheduler } from './infrastructure/scheduler/managerScheduler.js';
import { DatabaseHealthChecker, SchedulerHealthChecker } from './infrastructure/http/healthCheckers.js';
import { getPool } from './infrastructure/persistence/pg.js';

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

  // 2. Read version from package.json (once at startup)
  const packageJsonPath = new URL('../package.json', import.meta.url).pathname;
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
  const version = packageJson.version;

  // 3. PG pool + auto-migrate
  createPool(config.databaseUrl);

  const knexConfig = (await import('./infrastructure/persistence/knexfile.js')).default;
  const migrationsDir = new URL('./infrastructure/persistence/migrations', import.meta.url).pathname;
  const knex = (await import('knex')).default({
    ...knexConfig,
    migrations: { ...knexConfig.migrations, directory: migrationsDir },
  });
  try {
    const [batch, log] = await knex.migrate.latest();
    if (log.length > 0) {
      console.log('[init] Migrations applied (batch %d): %s', batch, log.join(', '));
    }
  } catch (err) {
    console.error('[init] Migration failed:', err.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }

  // 4. Roles
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
  const callbackSender = new CallbackClient();

  // 5a. MCP HTTP server (single long-lived process, SSE transport)
  const mcpPort = parseInt(process.env.MCP_PORT || '3100', 10);
  const mcpHttpServer = await startMcpHttpServer(
    { runRepo, taskRepo, callbackSender, logger: console },
    mcpPort,
  );

  // 5b. Write a shared mcp-config.json pointing at the HTTP server (with auth token)
  const mcpTmpDir = await mkdtemp(join(tmpdir(), 'neuroforge-mcp-'));
  const mcpConfigPath = join(mcpTmpDir, 'mcp-config.json');
  await writeFile(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        neuroforge: {
          type: 'sse',
          url: `http://localhost:${mcpPort}/sse`,
          headers: { Authorization: `Bearer ${mcpHttpServer.secret}` },
        },
      },
    }, null, 2),
    { encoding: 'utf-8', mode: 0o600 },
  );
  console.log('[init] MCP config written to %s', mcpConfigPath);

  const chatEngine = new ClaudeCLIAdapter({
    roleRegistry,
    workDir: config.workDir,
    mcpConfigPath,
  });

  // 6. Domain services
  const taskService = new TaskService({ taskRepo });
  const runService = new RunService({ runRepo });
  const runAbortRegistry = new RunAbortRegistry();

  // 7. Use cases
  const gitOps = new GitCLIAdapter({ logger: console });
  const startNextPendingTask = new StartNextPendingTask({ taskRepo, runService, roleRegistry });
  const createTask = new CreateTask({ taskService, runService, roleRegistry, projectRepo, taskRepo, callbackSender, gitOps, workDir: config.workDir });
  const processRun = new ProcessRun({ runRepo, runService, taskRepo, projectRepo, chatEngine, sessionRepo, roleRegistry, callbackSender, gitOps, workDir: config.workDir, runAbortRegistry, logger: console });
  const managerDecision = new ManagerDecision({ runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo, sessionRepo, projectRepo, gitOps, workDir: config.workDir, logger: console, startNextPendingTask });
  const getTaskStatus = new GetTaskStatus({ taskService, runRepo, projectRepo });
  const getRunDetail = new GetRunDetail({ taskService, runRepo });
  const cancelTask = new CancelTask({ taskService, runRepo, runService, projectRepo, callbackSender, startNextPendingTask, runAbortRegistry, logger: console });
  const replyToQuestion = new ReplyToQuestion({ taskService, runService, runRepo, projectRepo, callbackSender });
  const restartTask = new RestartTask({ taskService, runService, runRepo, projectRepo, roleRegistry, managerDecision, callbackSender });
  const enqueueTask = new EnqueueTask({ taskService, startNextPendingTask, projectRepo });
  const resumeResearch = new ResumeResearch({
    taskService, runService, runRepo, taskRepo, projectRepo,
    roleRegistry, callbackSender, logger: console,
  });
  const reviseAnalysis = new ReviseAnalysis({
    taskService, runService, runRepo, taskRepo, projectRepo,
    roleRegistry, callbackSender, logger: console,
  });

  // 8. Worker + Scheduler
  const worker = createWorker({ processRun, managerDecision, logger: console });
  const scheduler = new ManagerScheduler({
    worker,
    runRepo,
    runService,
    roleRegistry,
    logger: console,
    config: config.manager,
  });

  // 9. Health checkers + HTTP server
  const startedAt = new Date();
  const checkers = {
    database: new DatabaseHealthChecker({ pool: getPool() }),
    scheduler: new SchedulerHealthChecker({ scheduler }),
  };
  const useCases = { createTask, getTaskStatus, getRunDetail, cancelTask, replyToQuestion, restartTask, enqueueTask, resumeResearch, reviseAnalysis };
  const repos = { apiKeyRepo, userRepo, projectRepo, taskRepo, runRepo };
  const server = await createServer({ useCases, repos, checkers, version, startedAt });

  // 10. Graceful shutdown
  setupShutdown({ server, scheduler, mcpHttpServer, mcpConfigPath, mcpTmpDir });

  // 11. Start
  await server.listen({ port: config.port, host: config.host });
  console.log('[init] Server listening on %s:%d', config.host, config.port);

  await scheduler.start();
}

function setupShutdown({ server, scheduler, mcpHttpServer, mcpConfigPath, mcpTmpDir }) {
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

      // 3. Close MCP HTTP server
      if (mcpHttpServer && mcpHttpServer.closeMcp) {
        await mcpHttpServer.closeMcp();
        console.log('[shutdown] MCP server closed');
      }

      // 4. Cleanup MCP config temp file
      try {
        await unlink(mcpConfigPath);
        await rmdir(mcpTmpDir);
      } catch {
        // Ignore cleanup errors
      }

      // 5. Close PG pool
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
