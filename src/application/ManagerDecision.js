import { RunNotFoundError } from '../domain/errors/RunNotFoundError.js';
import { InvalidStateError } from '../domain/errors/InvalidStateError.js';

export class ManagerDecision {
  #runService;
  #taskService;
  #chatEngine;
  #roleRegistry;
  #callbackSender;
  #runRepo;

  constructor({ runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo }) {
    this.#runService = runService;
    this.#taskService = taskService;
    this.#chatEngine = chatEngine;
    this.#roleRegistry = roleRegistry;
    this.#callbackSender = callbackSender;
    this.#runRepo = runRepo;
  }

  async execute({ completedRunId }) {
    const completedRun = await this.#runRepo.findById(completedRunId);
    if (!completedRun) throw new RunNotFoundError(completedRunId);

    const terminalStatuses = ['done', 'failed', 'timeout'];
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
          { type: 'failed', taskId: task.id, error: `Manager agent failed: ${error.message}` },
          task.callbackMeta,
        );
      }
      return { action: 'fail_task', details: { reason: error.message } };
    }

    const decision = parseManagerDecision(result.response);
    if (!decision) {
      await this.#taskService.failTask(task.id);
      if (task.callbackUrl) {
        await this.#callbackSender.send(
          task.callbackUrl,
          { type: 'failed', taskId: task.id, error: 'Manager returned unparseable response' },
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
              { type: 'progress', taskId: task.id, stage: decision.role, message: `Переход к этапу: ${decision.role}` },
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
              { type: 'done', taskId: task.id, summary: decision.summary },
              task.callbackMeta,
            );
          }
          break;
        }

        case 'fail_task': {
          await this.#taskService.failTask(task.id);
          if (task.callbackUrl) {
            await this.#callbackSender.send(
              task.callbackUrl,
              { type: 'failed', taskId: task.id, error: decision.reason },
              task.callbackMeta,
            );
          }
          break;
        }
      }
    } catch (error) {
      // RevisionLimitError or other errors during decision execution
      await this.#taskService.failTask(task.id).catch(() => {});
      if (task.callbackUrl) {
        await this.#callbackSender.send(
          task.callbackUrl,
          { type: 'failed', taskId: task.id, error: error.message },
          task.callbackMeta,
        );
      }
      return { action: 'fail_task', details: { reason: error.message } };
    }

    return { action: decision.action, details: decision };
  }
}

/**
 * Build the prompt for the manager agent with task context and run history.
 */
function buildManagerPrompt(task, runs) {
  const completedRuns = runs
    .filter(r => ['done', 'failed', 'timeout'].includes(r.status))
    .sort((a, b) => a.createdAt - b.createdAt);

  const runsReport = completedRuns
    .map(r => `[${r.roleName}] status=${r.status}\n${r.response ?? r.error ?? 'no output'}`)
    .join('\n---\n');

  return `Задача: ${task.title}
Описание: ${task.description ?? 'нет'}
Текущий статус: ${task.status}
Количество ревизий: ${task.revisionCount}

Завершённые шаги:
${runsReport}

Прими решение о следующем шаге. Ответь строго в формате JSON:
{
  "action": "spawn_run" | "ask_owner" | "complete_task" | "fail_task",
  "role": "имя_роли",
  "prompt": "промпт",
  "question": "вопрос",
  "context": "контекст",
  "summary": "итог",
  "reason": "причина"
}`;
}

/**
 * Parse manager's JSON decision from response text.
 */
function parseManagerDecision(response) {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const decision = JSON.parse(jsonMatch[0]);
    const validActions = ['spawn_run', 'ask_owner', 'complete_task', 'fail_task'];
    if (!validActions.includes(decision.action)) return null;
    return decision;
  } catch {
    return null;
  }
}

export { buildManagerPrompt, parseManagerDecision };
