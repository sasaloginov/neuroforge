import { RunNotFoundError } from '../domain/errors/RunNotFoundError.js';
import { InvalidStateError } from '../domain/errors/InvalidStateError.js';
import { ReviewFindings } from '../domain/valueObjects/ReviewFindings.js';

/**
 * Pipeline v2: Deterministic-first PM orchestrator.
 *
 * 90% of transitions are handled deterministically (no LLM call):
 *   analyst_done   → developer phase (--resume implementer session)
 *   developer_done → reviewer
 *   reviewer PASS  → merge_and_complete
 *   reviewer FAIL  → developer fix (--resume) → re-review
 *   revision limit → escalation
 *
 * PM LLM is called only for errors and edge cases (fallback).
 */

const REVIEWER_ROLES = ['reviewer', 'reviewer-architecture', 'reviewer-business', 'reviewer-security'];
const MAX_REVIEW_REVISIONS = 3;

export class ManagerDecision {
  #runService;
  #taskService;
  #chatEngine;
  #roleRegistry;
  #callbackSender;
  #runRepo;
  #sessionRepo;
  #gitOps;
  #workDir;
  #logger;

  #startNextPendingTask;

  constructor({ runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo, sessionRepo, gitOps, workDir, logger, startNextPendingTask }) {
    this.#runService = runService;
    this.#taskService = taskService;
    this.#chatEngine = chatEngine;
    this.#roleRegistry = roleRegistry;
    this.#callbackSender = callbackSender;
    this.#runRepo = runRepo;
    this.#sessionRepo = sessionRepo || null;
    this.#gitOps = gitOps || null;
    this.#workDir = workDir || null;
    this.#logger = logger || console;
    this.#startNextPendingTask = startNextPendingTask || null;
  }

  async execute({ completedRunId }) {
    const completedRun = await this.#runRepo.findById(completedRunId);
    if (!completedRun) throw new RunNotFoundError(completedRunId);

    const terminalStatuses = ['done', 'failed', 'timeout', 'interrupted'];
    if (!terminalStatuses.includes(completedRun.status)) {
      throw new InvalidStateError(`Run is not in terminal state: ${completedRun.status}`);
    }

    const task = await this.#taskService.getTask(completedRun.taskId);

    // If task is already terminal or cancelled, skip
    if (['done', 'failed', 'cancelled', 'research_done'].includes(task.status)) {
      return { action: 'skipped', details: { reason: 'Task already terminal', taskId: task.id } };
    }

    const allRuns = await this.#runRepo.findByTaskId(task.id);

    // Check if parallel runs are still pending
    const pendingRuns = allRuns.filter(r => r.status === 'queued' || r.status === 'running');
    if (pendingRuns.length > 0) {
      return { action: 'waiting', details: { pendingCount: pendingRuns.length } };
    }

    // --- Deterministic routing (no LLM) ---

    // Research-mode: auto-complete after analyst (no LLM call)
    const researchResult = await this.#handleResearchMode(task, allRuns);
    if (researchResult) return researchResult;

    // Deterministic pipeline transitions
    const deterministicResult = await this.#handleDeterministicTransition(task, allRuns);
    if (deterministicResult) return deterministicResult;

    // --- Fallback: PM LLM for edge cases ---
    return this.#callPmLlm(task, allRuns);
  }

  /**
   * Deterministic pipeline routing — covers 90% of transitions.
   * Returns result object or null to fall through to PM LLM.
   */
  async #handleDeterministicTransition(task, allRuns) {
    const completedRuns = allRuns
      .filter(r => ['done', 'failed', 'timeout', 'interrupted'].includes(r.status))
      .sort((a, b) => a.createdAt - b.createdAt);

    const lastRun = completedRuns[completedRuns.length - 1];
    if (!lastRun) return null;

    // Failed/timeout runs → fall through to PM LLM
    if (lastRun.status !== 'done') return null;

    const role = lastRun.roleName;

    // 1. analyst_done → developer phase (--resume implementer session)
    if (role === 'analyst' || (role === 'implementer' && this.#isAnalystPhase(lastRun))) {
      return this.#transitionToDeveloper(task, lastRun);
    }

    // 2. developer_done → reviewer
    if (role === 'developer' || (role === 'implementer' && this.#isDeveloperPhase(lastRun))) {
      // Check for re-review after fix
      const devFixResult = await this.#handleDevFixComplete(task, allRuns);
      if (devFixResult) return devFixResult;

      return this.#transitionToReviewer(task);
    }

    // 3. reviewer done → analyze findings
    if (REVIEWER_ROLES.includes(role)) {
      return this.#handleReviewComplete(task, allRuns);
    }

    return null;
  }

  /**
   * analyst_done → spawn developer phase (resume implementer session).
   */
  async #transitionToDeveloper(task, analystRun) {
    const roleName = this.#roleRegistry.has('implementer') ? 'implementer' : 'developer';

    const prompt = `Фаза: developer.

Задача: ${task.shortId ?? ''} ${task.title}
Описание: ${task.description ?? 'нет'}
Ветка: ${task.branchName ?? 'не назначена'}

Реализуй задачу по спецификации из design/spec.md. Используй context.md для навигации.
Напиши код, тесты, убедись что тесты проходят. Закоммить изменения.`;

    await this.#runService.enqueue({
      taskId: task.id,
      stepId: null,
      roleName,
      prompt,
      callbackUrl: task.callbackUrl,
      callbackMeta: task.callbackMeta,
    });

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        { type: 'progress', taskId: task.id, shortId: task.shortId, stage: 'developer', message: 'Переход к разработке (--resume)' },
        task.callbackMeta,
      );
    }

    return { action: 'deterministic_transition', details: { from: 'analyst', to: 'developer' } };
  }

  /**
   * developer_done → spawn reviewer.
   */
  async #transitionToReviewer(task) {
    const roleName = this.#roleRegistry.has('reviewer') ? 'reviewer' : 'reviewer-architecture';

    const prompt = `Задача: ${task.title}
Описание: ${task.description ?? 'нет'}
Ветка: ${task.branchName ?? 'не назначена'}

Проведи полное ревью (архитектура + бизнес-логика + безопасность).
Начни с \`git diff main..HEAD\` — это главный вход для ревью.

Ответь в формате:
VERDICT: PASS или FAIL
FINDINGS (если есть):
[SEVERITY] Описание проблемы
SUMMARY: краткое резюме`;

    await this.#runService.enqueue({
      taskId: task.id,
      stepId: null,
      roleName,
      prompt,
      callbackUrl: task.callbackUrl,
      callbackMeta: task.callbackMeta,
    });

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        { type: 'progress', taskId: task.id, shortId: task.shortId, stage: 'reviewer', message: 'Переход к ревью' },
        task.callbackMeta,
      );
    }

    return { action: 'deterministic_transition', details: { from: 'developer', to: 'reviewer' } };
  }

  /**
   * reviewer done → analyze findings.
   * PASS → merge_and_complete
   * FAIL with blocking → revision cycle
   * revision limit → escalation
   */
  async #handleReviewComplete(task, allRuns) {
    const completedRuns = allRuns
      .filter(r => ['done', 'failed', 'timeout', 'interrupted'].includes(r.status))
      .sort((a, b) => a.createdAt - b.createdAt);

    // Find the last developer/implementer run
    const lastDevRun = [...completedRuns].reverse().find(
      r => r.roleName === 'developer' || (r.roleName === 'implementer' && this.#isDeveloperPhase(r)),
    );
    if (!lastDevRun) return null;

    // Find reviewer runs after the last dev run
    const reviewerRuns = completedRuns.filter(
      r => REVIEWER_ROLES.includes(r.roleName)
        && r.createdAt > lastDevRun.createdAt
        && r.status === 'done',
    );
    if (reviewerRuns.length === 0) return null;

    const { blockingFindings, minorFindings, reviewersWithIssues, hasBlockingIssues } =
      ReviewFindings.parseAll(reviewerRuns);

    const actionableFindings = [...blockingFindings, ...minorFindings.filter(f => f.severity !== 'LOW')];

    // All reviews PASS (no actionable findings) → merge and complete
    if (actionableFindings.length === 0) {
      return this.#mergeAndComplete(task);
    }

    // Blocking findings + over revision limit → escalate
    if (task.revisionCount >= MAX_REVIEW_REVISIONS) {
      await this.#taskService.escalateTask(task.id);
      if (task.callbackUrl) {
        await this.#callbackSender.send(
          task.callbackUrl,
          {
            type: 'needs_escalation',
            taskId: task.id,
            shortId: task.shortId,
            findings: blockingFindings,
            revisionCount: task.revisionCount,
          },
          task.callbackMeta,
        );
      }
      return { action: 'needs_escalation', details: { findings: blockingFindings, revisionCount: task.revisionCount } };
    }

    // Under revision limit → enqueue developer fix
    await this.#taskService.incrementRevision(task.id);

    const fixPrompt = buildFixPrompt(task, actionableFindings);
    const roleName = this.#roleRegistry.has('implementer') ? 'implementer' : 'developer';

    await this.#runService.enqueue({
      taskId: task.id,
      stepId: null,
      roleName,
      prompt: fixPrompt,
      callbackUrl: task.callbackUrl,
      callbackMeta: task.callbackMeta,
    });

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        {
          type: 'progress',
          taskId: task.id,
          shortId: task.shortId,
          stage: 'revision',
          message: `Ревизия ${task.revisionCount + 1}: исправление ${actionableFindings.length} замечаний`,
        },
        task.callbackMeta,
      );
    }

    return {
      action: 'revision_cycle',
      details: {
        findings: actionableFindings,
        reviewersWithIssues,
        revisionCount: task.revisionCount,
      },
    };
  }

  /**
   * After developer fix completes — enqueue re-review.
   */
  async #handleDevFixComplete(task, allRuns) {
    if (task.revisionCount === 0) return null;

    const completedRuns = allRuns
      .filter(r => ['done', 'failed', 'timeout', 'interrupted'].includes(r.status))
      .sort((a, b) => a.createdAt - b.createdAt);

    const lastRun = completedRuns[completedRuns.length - 1];
    if (!lastRun) return null;

    // Only trigger if last run is developer/implementer in developer phase
    const isDevRun = lastRun.roleName === 'developer'
      || (lastRun.roleName === 'implementer' && this.#isDeveloperPhase(lastRun));
    if (!isDevRun) return null;

    // Find previous reviewer runs that had findings
    const prevDevRun = [...completedRuns]
      .reverse()
      .find(r => (r.roleName === 'developer' || r.roleName === 'implementer') && r.id !== lastRun.id);

    const reviewerRuns = completedRuns.filter(
      r => REVIEWER_ROLES.includes(r.roleName)
        && r.status === 'done'
        && (prevDevRun ? r.createdAt > prevDevRun.createdAt : true)
        && r.createdAt < lastRun.createdAt,
    );

    if (reviewerRuns.length === 0) return null;

    const { reviewersWithIssues } = ReviewFindings.parseAll(reviewerRuns);
    if (reviewersWithIssues.length === 0) return null;

    // Enqueue re-review
    const reReviewPrompt = buildReReviewPrompt(task);
    const reviewerRole = this.#roleRegistry.has('reviewer') ? 'reviewer' : reviewersWithIssues[0];

    if (this.#roleRegistry.has('reviewer')) {
      // Unified reviewer: enqueue single re-review
      await this.#runService.enqueue({
        taskId: task.id,
        stepId: null,
        roleName: 'reviewer',
        prompt: reReviewPrompt,
        callbackUrl: task.callbackUrl,
        callbackMeta: task.callbackMeta,
      });
    } else {
      // Legacy: enqueue re-review for each reviewer that had issues
      for (const role of reviewersWithIssues) {
        await this.#runService.enqueue({
          taskId: task.id,
          stepId: null,
          roleName: role,
          prompt: reReviewPrompt,
          callbackUrl: task.callbackUrl,
          callbackMeta: task.callbackMeta,
        });
      }
    }

    this.#logger.info('[ManagerDecision] Dev fix complete, enqueued re-review');

    return {
      action: 're_review_after_fix',
      details: { reviewersWithIssues },
    };
  }

  /**
   * Merge branch to main and complete task.
   */
  async #mergeAndComplete(task) {
    // Attempt git merge if gitOps available
    if (this.#gitOps && this.#workDir && task.branchName) {
      try {
        await this.#gitOps.mergeBranch(task.branchName, this.#workDir);
        this.#logger.info('[ManagerDecision] Merged branch %s to main', task.branchName);
      } catch (err) {
        this.#logger.error('[ManagerDecision] Merge failed: %s', err.message);
        // Merge failure → escalate instead of completing
        await this.#taskService.escalateTask(task.id);
        if (task.callbackUrl) {
          await this.#callbackSender.send(
            task.callbackUrl,
            {
              type: 'needs_escalation',
              taskId: task.id,
              shortId: task.shortId,
              findings: [{ severity: 'CRITICAL', description: `Merge failed: ${err.message}` }],
              revisionCount: task.revisionCount,
            },
            task.callbackMeta,
          );
        }
        return { action: 'needs_escalation', details: { reason: `Merge failed: ${err.message}` } };
      }
    }

    await this.#taskService.completeTask(task.id);
    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        { type: 'done', taskId: task.id, shortId: task.shortId, summary: 'Задача выполнена. Ревью пройдено, ветка вмержена.' },
        task.callbackMeta,
      );
    }
    await this.#tryStartNext(task.projectId);

    return { action: 'merge_and_complete', details: { branchName: task.branchName } };
  }

  /**
   * Research mode: after analyst completes → auto complete_task.
   */
  async #handleResearchMode(task, allRuns) {
    if (task.mode !== 'research') return null;

    const completedRuns = allRuns
      .filter(r => ['done', 'failed', 'timeout', 'interrupted'].includes(r.status));

    // Find last analyst/implementer run
    const lastAnalystRun = [...completedRuns]
      .reverse()
      .find(r => r.roleName === 'analyst' || r.roleName === 'implementer');

    if (!lastAnalystRun) return null;

    // Analyst failed → let PM LLM decide (retry/fail)
    if (lastAnalystRun.status !== 'done') return null;

    const fullResult = lastAnalystRun.response ?? '';

    const TELEGRAM_MESSAGE_LIMIT = 4096;
    const resultFormat = fullResult.length > TELEGRAM_MESSAGE_LIMIT ? 'file' : 'message';

    const MAX_CALLBACK_RESULT_BYTES = 50 * 1024;
    const truncated = fullResult.length > MAX_CALLBACK_RESULT_BYTES;
    const result = truncated
      ? fullResult.slice(0, MAX_CALLBACK_RESULT_BYTES) + '\n\n…[truncated]'
      : fullResult;

    await this.#taskService.completeResearch(task.id);

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        {
          type: 'research_done',
          taskId: task.id,
          shortId: task.shortId,
          mode: 'research',
          summary: 'Исследование завершено. Отправьте /resume для продолжения в разработку.',
          result,
          resultFormat,
          truncated,
        },
        task.callbackMeta,
      );
    }

    await this.#tryStartNext(task.projectId);

    return {
      action: 'complete_task',
      details: { mode: 'research', resultLength: fullResult.length, resultFormat, truncated },
    };
  }

  /**
   * Fallback: call PM LLM for edge cases.
   */
  async #callPmLlm(task, allRuns) {
    const managerPrompt = buildManagerPrompt(task, allRuns);
    const pmRoleName = this.#roleRegistry.has('pm') ? 'pm' : 'manager';

    let result;
    let managerSession = null;
    try {
      const role = this.#roleRegistry.get(pmRoleName);

      // Find or create PM session for context accumulation
      if (this.#sessionRepo) {
        if (this.#sessionRepo.findOrCreateForTask) {
          managerSession = await this.#sessionRepo.findOrCreateForTask(task.id, task.projectId, pmRoleName);
        } else {
          managerSession = await this.#sessionRepo.findOrCreate(task.projectId, pmRoleName);
        }
      }

      result = await this.#chatEngine.runPrompt(pmRoleName, managerPrompt, {
        timeoutMs: role.timeoutMs,
        sessionId: managerSession?.cliSessionId || null,
      });

      // Save PM session for next --resume
      if (this.#sessionRepo && managerSession && result.sessionId && result.sessionId !== managerSession.cliSessionId) {
        managerSession.cliSessionId = result.sessionId;
        await this.#sessionRepo.save(managerSession);
      }
    } catch (error) {
      await this.#taskService.failTask(task.id);
      if (task.callbackUrl) {
        await this.#callbackSender.send(
          task.callbackUrl,
          { type: 'failed', taskId: task.id, shortId: task.shortId, error: `Manager agent failed: ${error.message}` },
          task.callbackMeta,
        );
      }
      return { action: 'fail_task', details: { reason: error.message } };
    }

    this.#logger.info('[ManagerDecision] Manager response (first 500 chars): %s', result.response.substring(0, 500));

    const decision = parseManagerDecision(result.response);
    if (!decision) {
      this.#logger.error('[ManagerDecision] Failed to parse decision from response (first 1000 chars): %s', result.response.substring(0, 1000));
      await this.#taskService.failTask(task.id);
      if (task.callbackUrl) {
        await this.#callbackSender.send(
          task.callbackUrl,
          { type: 'failed', taskId: task.id, shortId: task.shortId, error: 'Manager returned unparseable response' },
          task.callbackMeta,
        );
      }
      return { action: 'fail_task', details: { reason: 'Unparseable manager response' } };
    }

    try {
      switch (decision.action) {
        case 'spawn_run': {
          this.#roleRegistry.get(decision.role); // validate role exists

          // Check revision limit if re-spawning developer after a previous developer run
          const devRoles = ['developer', 'implementer'];
          if (devRoles.includes(decision.role) && allRuns.some(r => devRoles.includes(r.roleName) && r.status === 'done')) {
            await this.#taskService.incrementRevision(task.id);
          }

          await this.#runService.enqueue({
            taskId: task.id,
            stepId: null,
            roleName: decision.role,
            prompt: decision.prompt,
            callbackUrl: task.callbackUrl,
            callbackMeta: task.callbackMeta,
          });

          if (task.callbackUrl) {
            await this.#callbackSender.send(
              task.callbackUrl,
              { type: 'progress', taskId: task.id, shortId: task.shortId, stage: decision.role, message: `Переход к этапу: ${decision.role}` },
              task.callbackMeta,
            );
          }
          break;
        }

        case 'spawn_runs': {
          if (!Array.isArray(decision.runs) || decision.runs.length === 0) {
            throw new Error('spawn_runs requires non-empty "runs" array');
          }

          for (const runDef of decision.runs) {
            if (!runDef.role || !runDef.prompt) {
              throw new Error('Each run in spawn_runs must have "role" and "prompt"');
            }
            this.#roleRegistry.get(runDef.role);
          }

          const devRoles = ['developer', 'implementer'];
          const hasDevRun = decision.runs.some(r => devRoles.includes(r.role));
          if (hasDevRun && allRuns.some(r => devRoles.includes(r.roleName) && r.status === 'done')) {
            await this.#taskService.incrementRevision(task.id);
          }

          const enqueuedRoles = [];
          for (const runDef of decision.runs) {
            await this.#runService.enqueue({
              taskId: task.id,
              stepId: null,
              roleName: runDef.role,
              prompt: runDef.prompt,
              callbackUrl: task.callbackUrl,
              callbackMeta: task.callbackMeta,
            });
            enqueuedRoles.push(runDef.role);
          }

          if (task.callbackUrl) {
            await this.#callbackSender.send(
              task.callbackUrl,
              {
                type: 'progress',
                taskId: task.id,
                shortId: task.shortId,
                stage: enqueuedRoles.join('+'),
                message: `Параллельный запуск: ${enqueuedRoles.join(', ')}`,
              },
              task.callbackMeta,
            );
          }
          break;
        }

        case 'ask_owner': {
          await this.#taskService.requestReply(task.id);
          if (task.callbackUrl) {
            await this.#callbackSender.send(
              task.callbackUrl,
              {
                type: 'question',
                taskId: task.id,
                shortId: task.shortId,
                questionId: crypto.randomUUID(),
                question: decision.question,
                context: decision.context ?? '',
              },
              task.callbackMeta,
            );
          }
          break;
        }

        case 'merge_and_complete': {
          const mergeResult = await this.#mergeAndComplete(task);
          return mergeResult;
        }

        case 'complete_task': {
          await this.#taskService.completeTask(task.id);
          if (task.callbackUrl) {
            await this.#callbackSender.send(
              task.callbackUrl,
              { type: 'done', taskId: task.id, shortId: task.shortId, summary: decision.summary },
              task.callbackMeta,
            );
          }
          await this.#tryStartNext(task.projectId);
          break;
        }

        case 'fail_task': {
          await this.#taskService.failTask(task.id);
          if (task.callbackUrl) {
            await this.#callbackSender.send(
              task.callbackUrl,
              { type: 'failed', taskId: task.id, shortId: task.shortId, error: decision.reason },
              task.callbackMeta,
            );
          }
          await this.#tryStartNext(task.projectId);
          break;
        }
      }
    } catch (error) {
      await this.#taskService.failTask(task.id).catch(() => {});
      if (task.callbackUrl) {
        await this.#callbackSender.send(
          task.callbackUrl,
          { type: 'failed', taskId: task.id, shortId: task.shortId, error: error.message },
          task.callbackMeta,
        );
      }
      return { action: 'fail_task', details: { reason: error.message } };
    }

    return { action: decision.action, details: decision };
  }

  async #tryStartNext(projectId) {
    if (this.#startNextPendingTask) {
      try {
        await this.#startNextPendingTask.execute({ projectId });
      } catch (err) {
        this.#logger.error('[ManagerDecision] Failed to start next pending task: %s', err.message);
      }
    }
  }

  /** Check if an implementer run was in analyst phase. */
  #isAnalystPhase(run) {
    if (run.roleName !== 'implementer') return false;
    return run.prompt?.includes('Фаза: analyst') || !run.prompt?.includes('Фаза: developer');
  }

  /** Check if an implementer run was in developer phase. */
  #isDeveloperPhase(run) {
    if (run.roleName !== 'implementer') return false;
    return run.prompt?.includes('Фаза: developer') || run.prompt?.includes('Фаза: fix');
  }
}

/**
 * Build the prompt for the PM agent with task context and run history.
 */
function buildManagerPrompt(task, runs) {
  const completedRuns = runs
    .filter(r => ['done', 'failed', 'timeout', 'interrupted'].includes(r.status))
    .sort((a, b) => a.createdAt - b.createdAt);

  const lastRun = completedRuns[completedRuns.length - 1];
  // Only include the last run's output as delta (PM already has context via --resume)
  const deltaReport = lastRun
    ? `Последний завершённый шаг:
[${lastRun.roleName}] status=${lastRun.status}
${lastRun.response ?? lastRun.error ?? 'no output'}`
    : 'Нет завершённых шагов.';

  const allRunsSummary = completedRuns
    .map(r => `[${r.roleName}] status=${r.status}`)
    .join(', ');

  return `Задача: ${task.title}
Описание: ${task.description ?? 'нет'}
Ветка: ${task.branchName ?? 'не назначена'}
Режим: ${task.mode ?? 'auto'}
Текущий статус: ${task.status}
Количество ревизий: ${task.revisionCount}

История шагов: ${allRunsSummary || 'пусто'}

${deltaReport}

Прими решение о следующем шаге. Ответь строго в формате JSON:
{
  "action": "spawn_run" | "spawn_runs" | "ask_owner" | "merge_and_complete" | "complete_task" | "fail_task",
  "role": "имя_роли",
  "prompt": "промпт",
  "runs": [{"role":"имя","prompt":"промпт"}, ...] (для spawn_runs),
  "question": "вопрос",
  "context": "контекст",
  "summary": "итог",
  "reason": "причина"
}`;
}

/**
 * Parse PM's JSON decision from response text.
 */
function parseManagerDecision(response) {
  const validActions = ['spawn_run', 'spawn_runs', 'ask_owner', 'merge_and_complete', 'complete_task', 'fail_task'];

  function tryParse(text) {
    try {
      const decision = JSON.parse(text);
      if (decision && validActions.includes(decision.action)) return decision;
    } catch { /* ignore */ }
    return null;
  }

  const trimmed = response.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const fromBlock = tryParse(codeBlockMatch[1].trim());
    if (fromBlock) return fromBlock;
  }

  const actionMatch = trimmed.match(/\{[^{}]*"action"\s*:\s*"[^"]*"[^{}]*\}/);
  if (actionMatch) {
    const fromAction = tryParse(actionMatch[0]);
    if (fromAction) return fromAction;
  }

  const greedyMatch = trimmed.match(/\{[\s\S]*\}/);
  if (greedyMatch) {
    const fromGreedy = tryParse(greedyMatch[0]);
    if (fromGreedy) return fromGreedy;
  }

  return null;
}

/**
 * Build a prompt for the developer/implementer to fix blocking review findings.
 */
function buildFixPrompt(task, findings) {
  const blocking = findings.filter(f => ['CRITICAL', 'MAJOR', 'HIGH'].includes(f.severity));
  const minor = findings.filter(f => ['MINOR', 'LOW'].includes(f.severity));

  const formatList = (items) => items
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.description}${f.reviewerRole ? ` (${f.reviewerRole})` : ''}`)
    .join('\n');

  let prompt = `Фаза: fix.

Задача: ${task.title}
Описание: ${task.description ?? 'нет'}

Ревьюеры обнаружили замечания, которые необходимо исправить:`;

  if (blocking.length > 0) {
    prompt += `\n\nBlocking (обязательно исправить):\n${formatList(blocking)}`;
  }
  if (minor.length > 0) {
    prompt += `\n\nMinor (исправить если возможно):\n${formatList(minor)}`;
  }

  prompt += '\n\nИсправь ВСЕ перечисленные замечания. Не ломай существующую функциональность. После исправлений убедись что тесты проходят.';
  return prompt;
}

/**
 * Build a prompt for re-reviewing after developer fixes.
 */
function buildReReviewPrompt(task) {
  return `Задача: ${task.title}
Описание: ${task.description ?? 'нет'}

Разработчик внёс исправления по замечаниям предыдущего ревью. Проведи повторное ревью: проверь что все blocking замечания исправлены, и нет новых проблем.

Ответь в формате:
VERDICT: PASS или FAIL
FINDINGS (если есть):
[SEVERITY] Описание проблемы
SUMMARY: краткое резюме`;
}

export { buildManagerPrompt, parseManagerDecision, buildFixPrompt, buildReReviewPrompt };
