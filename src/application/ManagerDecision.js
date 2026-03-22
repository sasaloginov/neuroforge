import { RunNotFoundError } from '../domain/errors/RunNotFoundError.js';
import { InvalidStateError } from '../domain/errors/InvalidStateError.js';
import { ReviewFindings } from '../domain/valueObjects/ReviewFindings.js';

const REVIEWER_ROLES = ['reviewer-architecture', 'reviewer-business', 'reviewer-security'];
const MAX_REVIEW_REVISIONS = 3;

export class ManagerDecision {
  #runService;
  #taskService;
  #chatEngine;
  #roleRegistry;
  #callbackSender;
  #runRepo;
  #logger;

  #startNextPendingTask;

  constructor({ runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo, logger, startNextPendingTask }) {
    this.#runService = runService;
    this.#taskService = taskService;
    this.#chatEngine = chatEngine;
    this.#roleRegistry = roleRegistry;
    this.#callbackSender = callbackSender;
    this.#runRepo = runRepo;
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
    if (['done', 'failed', 'cancelled'].includes(task.status)) {
      return { action: 'skipped', details: { reason: 'Task already terminal', taskId: task.id } };
    }

    const allRuns = await this.#runRepo.findByTaskId(task.id);

    // Check if parallel runs are still pending
    const pendingRuns = allRuns.filter(r => r.status === 'queued' || r.status === 'running');
    if (pendingRuns.length > 0) {
      return { action: 'waiting', details: { pendingCount: pendingRuns.length } };
    }

    // Research-mode: auto-complete after analyst (no LLM call)
    const researchResult = await this.#handleResearchMode(task, allRuns);
    if (researchResult) {
      return researchResult;
    }

    // Automatic review severity handling (before calling manager LLM)
    const reviewResult = await this.#handleReviewFindings(task, allRuns);
    if (reviewResult) {
      return reviewResult;
    }

    // Build manager prompt and run manager agent
    const managerPrompt = buildManagerPrompt(task, allRuns);

    let result;
    try {
      const role = this.#roleRegistry.get('manager');
      result = await this.#chatEngine.runPrompt('manager', managerPrompt, { timeoutMs: role.timeoutMs });
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
          if (decision.role === 'developer' && allRuns.some(r => r.roleName === 'developer' && r.status === 'done')) {
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
          // Validate runs array
          if (!Array.isArray(decision.runs) || decision.runs.length === 0) {
            throw new Error('spawn_runs requires non-empty "runs" array');
          }

          // Validate all roles exist before enqueuing any
          for (const runDef of decision.runs) {
            if (!runDef.role || !runDef.prompt) {
              throw new Error('Each run in spawn_runs must have "role" and "prompt"');
            }
            this.#roleRegistry.get(runDef.role); // throws RoleNotFoundError
          }

          // Check revision limit for developer runs (if any)
          const hasDevRun = decision.runs.some(r => r.role === 'developer');
          if (hasDevRun && allRuns.some(r => r.roleName === 'developer' && r.status === 'done')) {
            await this.#taskService.incrementRevision(task.id);
          }

          // Enqueue all runs
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
      // RevisionLimitError or other errors during decision execution
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

  /**
   * Try to start the next pending task for the project.
   * @param {string} projectId
   */
  async #tryStartNext(projectId) {
    if (this.#startNextPendingTask) {
      try {
        await this.#startNextPendingTask.execute({ projectId });
      } catch (err) {
        this.#logger.error('[ManagerDecision] Failed to start next pending task: %s', err.message);
      }
    }
  }

  /**
   * Research mode: after analyst completes → auto complete_task.
   * No LLM call, no developer/reviewer pipeline.
   *
   * @param {object} task
   * @param {Array} allRuns
   * @returns {Promise<object|null>}
   */
  async #handleResearchMode(task, allRuns) {
    if (task.mode !== 'research') return null;

    const completedRuns = allRuns
      .filter(r => ['done', 'failed', 'timeout', 'interrupted'].includes(r.status));

    // Find last analyst run
    const lastAnalystRun = [...completedRuns]
      .reverse()
      .find(r => r.roleName === 'analyst');

    if (!lastAnalystRun) return null;

    // Analyst failed → let LLM manager decide (retry/fail)
    if (lastAnalystRun.status !== 'done') return null;

    // Analyst succeeded → complete task with analyst's response
    const result = lastAnalystRun.response ?? '';

    // Telegram message limit is 4096 chars. If result exceeds it,
    // signal the bot to send as a .md file instead of inline message.
    const TELEGRAM_MESSAGE_LIMIT = 4096;
    const resultFormat = result.length > TELEGRAM_MESSAGE_LIMIT ? 'file' : 'message';

    await this.#taskService.completeTask(task.id);

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        {
          type: 'done',
          taskId: task.id,
          shortId: task.shortId,
          mode: 'research',
          summary: 'Исследование завершено',
          result,
          resultFormat,
        },
        task.callbackMeta,
      );
    }

    await this.#tryStartNext(task.projectId);

    return {
      action: 'complete_task',
      details: { mode: 'research', resultLength: result.length, resultFormat },
    };
  }

  /**
   * Automatic review severity handling.
   * Analyzes review findings after the last developer run and decides:
   * - blocking + over revision limit → escalate
   * - blocking + under limit → enqueue developer fix + re-review
   * - only minor findings → send tech_debt callback, continue to LLM
   * - no reviewer runs after last dev run → null (continue to LLM)
   *
   * @param {object} task
   * @param {Array} allRuns
   * @returns {Promise<object|null>} — decision result or null to continue to LLM
   */
  async #handleReviewFindings(task, allRuns) {
    const completedRuns = allRuns
      .filter(r => ['done', 'failed', 'timeout', 'interrupted'].includes(r.status))
      .sort((a, b) => a.createdAt - b.createdAt);

    // Find the last developer run
    const lastDevRun = [...completedRuns].reverse().find(r => r.roleName === 'developer');
    if (!lastDevRun) return null;

    // Find reviewer runs that completed after the last dev run
    const reviewerRuns = completedRuns.filter(
      r => REVIEWER_ROLES.includes(r.roleName)
        && r.createdAt > lastDevRun.createdAt
        && r.status === 'done',
    );
    if (reviewerRuns.length === 0) return null;

    const { blockingFindings, minorFindings, reviewersWithBlockingIssues, hasBlockingIssues } =
      ReviewFindings.parseAll(reviewerRuns);

    // Only minor findings → send tech_debt callback, let LLM decide next step
    if (!hasBlockingIssues && minorFindings.length > 0) {
      if (task.callbackUrl) {
        await this.#callbackSender.send(
          task.callbackUrl,
          {
            type: 'tech_debt',
            taskId: task.id,
            shortId: task.shortId,
            findings: minorFindings,
          },
          task.callbackMeta,
        );
      }
      return null; // continue to manager LLM
    }

    if (!hasBlockingIssues) return null;

    // Blocking findings found — check revision limit
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

    // Under revision limit — enqueue developer fix + targeted re-review
    await this.#taskService.incrementRevision(task.id);

    const fixPrompt = buildFixPrompt(task, blockingFindings);
    await this.#runService.enqueue({
      taskId: task.id,
      stepId: null,
      roleName: 'developer',
      prompt: fixPrompt,
      callbackUrl: task.callbackUrl,
      callbackMeta: task.callbackMeta,
    });

    // Enqueue re-review only for reviewers that found blocking issues
    const reReviewPrompt = buildReReviewPrompt(task);
    for (const reviewerRole of reviewersWithBlockingIssues) {
      await this.#runService.enqueue({
        taskId: task.id,
        stepId: null,
        roleName: reviewerRole,
        prompt: reReviewPrompt,
        callbackUrl: task.callbackUrl,
        callbackMeta: task.callbackMeta,
      });
    }

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        {
          type: 'progress',
          taskId: task.id,
          shortId: task.shortId,
          stage: 'revision',
          message: `Ревизия ${task.revisionCount + 1}: исправление ${blockingFindings.length} blocking замечаний`,
        },
        task.callbackMeta,
      );
    }

    return {
      action: 'revision_cycle',
      details: {
        blockingFindings,
        reviewersWithBlockingIssues,
        revisionCount: task.revisionCount,
      },
    };
  }
}

/**
 * Build the prompt for the manager agent with task context and run history.
 */
function buildManagerPrompt(task, runs) {
  const completedRuns = runs
    .filter(r => ['done', 'failed', 'timeout', 'interrupted'].includes(r.status))
    .sort((a, b) => a.createdAt - b.createdAt);

  const runsReport = completedRuns
    .map(r => `[${r.roleName}] status=${r.status}\n${r.response ?? r.error ?? 'no output'}`)
    .join('\n---\n');

  return `Задача: ${task.title}
Описание: ${task.description ?? 'нет'}
Ветка: ${task.branchName ?? 'не назначена'}
Режим: ${task.mode ?? 'full'}
Текущий статус: ${task.status}
Количество ревизий: ${task.revisionCount}

Завершённые шаги:
${runsReport}

Прими решение о следующем шаге. Ответь строго в формате JSON:
{
  "action": "spawn_run" | "spawn_runs" | "ask_owner" | "complete_task" | "fail_task",
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
 * Parse manager's JSON decision from response text.
 * Tries multiple strategies: full response as JSON, code block extraction, greedy regex.
 */
function parseManagerDecision(response) {
  const validActions = ['spawn_run', 'spawn_runs', 'ask_owner', 'complete_task', 'fail_task'];

  function tryParse(text) {
    try {
      const decision = JSON.parse(text);
      if (decision && validActions.includes(decision.action)) return decision;
    } catch { /* ignore */ }
    return null;
  }

  // Strategy 1: entire response is JSON
  const trimmed = response.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;

  // Strategy 2: JSON in a code block (```json ... ``` or ``` ... ```)
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const fromBlock = tryParse(codeBlockMatch[1].trim());
    if (fromBlock) return fromBlock;
  }

  // Strategy 3: find JSON object containing "action" key
  const actionMatch = trimmed.match(/\{[^{}]*"action"\s*:\s*"[^"]*"[^{}]*\}/);
  if (actionMatch) {
    const fromAction = tryParse(actionMatch[0]);
    if (fromAction) return fromAction;
  }

  // Strategy 4: last resort — greedy match from first { to last }
  const greedyMatch = trimmed.match(/\{[\s\S]*\}/);
  if (greedyMatch) {
    const fromGreedy = tryParse(greedyMatch[0]);
    if (fromGreedy) return fromGreedy;
  }

  return null;
}

/**
 * Build a prompt for the developer to fix blocking review findings.
 */
function buildFixPrompt(task, blockingFindings) {
  const findingsList = blockingFindings
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.description}${f.reviewerRole ? ` (${f.reviewerRole})` : ''}`)
    .join('\n');

  return `Задача: ${task.title}
Описание: ${task.description ?? 'нет'}

Ревьюеры обнаружили следующие blocking замечания, которые необходимо исправить:

${findingsList}

Исправь ВСЕ перечисленные замечания. Не ломай существующую функциональность. После исправлений убедись что тесты проходят.`;
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
