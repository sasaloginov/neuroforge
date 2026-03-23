import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManagerDecision, parseManagerDecision, buildManagerPrompt, buildFixPrompt, buildReReviewPrompt } from './ManagerDecision.js';
import { RunNotFoundError } from '../domain/errors/RunNotFoundError.js';
import { InvalidStateError } from '../domain/errors/InvalidStateError.js';
import { RoleNotFoundError } from '../domain/errors/RoleNotFoundError.js';
import { RevisionLimitError } from '../domain/errors/RevisionLimitError.js';

describe('ManagerDecision', () => {
  let managerDecision;
  let runService;
  let taskService;
  let chatEngine;
  let roleRegistry;
  let callbackSender;
  let runRepo;

  const makeRun = (overrides = {}) => ({
    id: 'run-1',
    taskId: 'task-1',
    roleName: 'analyst',
    status: 'done',
    response: 'Analysis complete',
    error: null,
    prompt: 'Фаза: analyst. Analyze task.',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  });

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    title: 'Build feature X',
    description: 'Build a REST API',
    status: 'in_progress',
    revisionCount: 0,
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    projectId: 'proj-1',
    ...overrides,
  });

  beforeEach(() => {
    runService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'run-new', status: 'queued' }),
    };
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
      requestReply: vi.fn().mockResolvedValue(undefined),
      completeTask: vi.fn().mockResolvedValue(undefined),
      failTask: vi.fn().mockResolvedValue(undefined),
      incrementRevision: vi.fn().mockResolvedValue(undefined),
      escalateTask: vi.fn().mockResolvedValue(undefined),
      completeResearch: vi.fn().mockResolvedValue(undefined),
    };
    chatEngine = {
      runPrompt: vi.fn().mockResolvedValue({
        response: JSON.stringify({ action: 'spawn_run', role: 'implementer', prompt: 'Implement the feature' }),
        sessionId: 'mgr-session',
      }),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'pm', timeoutMs: 600000 }),
      has: vi.fn().mockImplementation((name) => ['implementer', 'reviewer', 'pm'].includes(name)),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };
    runRepo = {
      findById: vi.fn().mockResolvedValue(makeRun()),
      findByTaskId: vi.fn().mockResolvedValue([makeRun()]),
    };

    managerDecision = new ManagerDecision({ runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo });
  });

  describe('deterministic transitions', () => {
    it('analyst_done → enqueues developer phase (implementer)', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'done' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'done', prompt: 'Фаза: analyst.' }),
      ]);

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('deterministic_transition');
      expect(result.details.from).toBe('analyst');
      expect(result.details.to).toBe('developer');
      expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        roleName: 'implementer',
      }));
      // No LLM call
      expect(chatEngine.runPrompt).not.toHaveBeenCalled();
    });

    it('implementer analyst phase → enqueues developer phase', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'implementer', status: 'done', prompt: 'Фаза: analyst.' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'implementer', status: 'done', prompt: 'Фаза: analyst.' }),
      ]);

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('deterministic_transition');
      expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        roleName: 'implementer',
      }));
      expect(chatEngine.runPrompt).not.toHaveBeenCalled();
    });

    it('developer_done → enqueues reviewer', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'developer', status: 'done' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ id: 'run-0', roleName: 'analyst', status: 'done', createdAt: new Date('2026-01-01') }),
        makeRun({ id: 'run-1', roleName: 'developer', status: 'done', createdAt: new Date('2026-01-02') }),
      ]);

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('deterministic_transition');
      expect(result.details.from).toBe('developer');
      expect(result.details.to).toBe('reviewer');
      expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        roleName: 'reviewer',
      }));
      expect(chatEngine.runPrompt).not.toHaveBeenCalled();
    });

    it('reviewer PASS → merge_and_complete', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'reviewer', status: 'done' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ id: 'run-dev', roleName: 'developer', status: 'done', createdAt: new Date('2026-01-01') }),
        makeRun({ id: 'run-rev', roleName: 'reviewer', status: 'done', response: 'VERDICT: PASS\nSUMMARY: All good', createdAt: new Date('2026-01-02') }),
      ]);

      const result = await managerDecision.execute({ completedRunId: 'run-rev' });

      expect(result.action).toBe('merge_and_complete');
      expect(taskService.completeTask).toHaveBeenCalledWith('task-1');
      expect(chatEngine.runPrompt).not.toHaveBeenCalled();
    });

    it('reviewer PASS with MINOR findings → still merge_and_complete (minors are informational)', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'reviewer', status: 'done' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ id: 'run-dev', roleName: 'developer', status: 'done', createdAt: new Date('2026-01-01') }),
        makeRun({ id: 'run-rev', roleName: 'reviewer', status: 'done', response: 'VERDICT: PASS\n[MINOR] Naming style\nSUMMARY: Minor style issues only', createdAt: new Date('2026-01-02') }),
      ]);

      const result = await managerDecision.execute({ completedRunId: 'run-rev' });

      expect(result.action).toBe('merge_and_complete');
      expect(chatEngine.runPrompt).not.toHaveBeenCalled();
    });

    it('reviewer FAIL with blocking → revision cycle', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'reviewer', status: 'done' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ id: 'run-dev', roleName: 'developer', status: 'done', createdAt: new Date('2026-01-01') }),
        makeRun({ id: 'run-rev', roleName: 'reviewer', status: 'done', response: '[MAJOR] DDD layer violation\nVERDICT: FAIL', createdAt: new Date('2026-01-02') }),
      ]);

      const result = await managerDecision.execute({ completedRunId: 'run-rev' });

      expect(result.action).toBe('revision_cycle');
      expect(taskService.incrementRevision).toHaveBeenCalled();
      expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        roleName: 'implementer',
      }));
      expect(chatEngine.runPrompt).not.toHaveBeenCalled();
    });

    it('reviewer FAIL + revision limit → escalation', async () => {
      taskService.getTask.mockResolvedValue(makeTask({ revisionCount: 3 }));
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'reviewer', status: 'done' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ id: 'run-dev', roleName: 'developer', status: 'done', createdAt: new Date('2026-01-01') }),
        makeRun({ id: 'run-rev', roleName: 'reviewer', status: 'done', response: '[CRITICAL] SQL injection\nVERDICT: FAIL', createdAt: new Date('2026-01-02') }),
      ]);

      const result = await managerDecision.execute({ completedRunId: 'run-rev' });

      expect(result.action).toBe('needs_escalation');
      expect(taskService.escalateTask).toHaveBeenCalled();
      expect(chatEngine.runPrompt).not.toHaveBeenCalled();
    });

    it('sends progress callback on developer transition', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'done' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'done' }),
      ]);

      await managerDecision.execute({ completedRunId: 'run-1' });

      expect(callbackSender.send).toHaveBeenCalledWith(
        'https://example.com/cb',
        expect.objectContaining({ type: 'progress', stage: 'developer' }),
        { chatId: 1 },
      );
    });
  });

  describe('PM LLM fallback', () => {
    it('calls PM LLM when last run failed', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'failed' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'failed' }),
      ]);

      await managerDecision.execute({ completedRunId: 'run-1' });

      expect(chatEngine.runPrompt).toHaveBeenCalled();
    });

    it('spawn_run: enqueues run from PM decision', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'failed' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'failed' }),
      ]);

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('spawn_run');
      expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        roleName: 'implementer',
      }));
    });

    it('ask_owner: transitions task to waiting_reply', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'failed' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'failed' }),
      ]);
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({ action: 'ask_owner', question: 'Which DB?', context: 'Need decision' }),
      });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('ask_owner');
      expect(taskService.requestReply).toHaveBeenCalledWith('task-1');
    });

    it('complete_task: completes task and sends done callback', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'failed' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'failed' }),
      ]);
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({ action: 'complete_task', summary: 'All done!' }),
      });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('complete_task');
      expect(taskService.completeTask).toHaveBeenCalledWith('task-1');
    });

    it('fail_task: fails task and sends failure callback', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'failed' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'failed' }),
      ]);
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({ action: 'fail_task', reason: 'Impossible requirement' }),
      });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('fail_task');
      expect(taskService.failTask).toHaveBeenCalledWith('task-1');
    });

    it('fails task when PM returns unparseable response', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'failed' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'failed' }),
      ]);
      chatEngine.runPrompt.mockResolvedValue({ response: 'I am not sure what to do next' });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('fail_task');
      expect(taskService.failTask).toHaveBeenCalledWith('task-1');
    });

    it('fails task when chatEngine throws during PM execution', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'failed' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'failed' }),
      ]);
      chatEngine.runPrompt.mockRejectedValue(new Error('Manager agent crashed'));

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('fail_task');
      expect(taskService.failTask).toHaveBeenCalledWith('task-1');
    });
  });

  describe('common behavior', () => {
    it('waits when parallel runs are still pending', async () => {
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ id: 'run-1', status: 'done' }),
        makeRun({ id: 'run-2', status: 'running' }),
      ]);

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result).toEqual({ action: 'waiting', details: { pendingCount: 1 } });
      expect(chatEngine.runPrompt).not.toHaveBeenCalled();
    });

    it('skips when task is already cancelled', async () => {
      taskService.getTask.mockResolvedValue(makeTask({ status: 'cancelled' }));

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('skipped');
    });

    it('skips when task is already done', async () => {
      taskService.getTask.mockResolvedValue(makeTask({ status: 'done' }));

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('skipped');
    });

    it('throws RunNotFoundError when run does not exist', async () => {
      runRepo.findById.mockResolvedValue(null);

      await expect(managerDecision.execute({ completedRunId: 'nonexistent' })).rejects.toThrow(RunNotFoundError);
    });

    it('throws InvalidStateError when run is not in terminal state', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ status: 'running' }));

      await expect(managerDecision.execute({ completedRunId: 'run-1' })).rejects.toThrow(InvalidStateError);
    });

    it('does not send callback when callbackUrl is null', async () => {
      taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'done' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'done' }),
      ]);

      await managerDecision.execute({ completedRunId: 'run-1' });

      expect(callbackSender.send).not.toHaveBeenCalled();
    });
  });

  describe('dev fix complete (re-review scheduling)', () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T00:01:00Z');
    const t2 = new Date('2026-01-01T00:02:00Z');

    it('enqueues re-review after developer fix completes', async () => {
      taskService.getTask.mockResolvedValue(makeTask({ revisionCount: 1 }));
      runRepo.findById.mockResolvedValue(makeRun({ id: 'run-dev-fix', roleName: 'developer', status: 'done' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ id: 'run-dev-1', roleName: 'developer', status: 'done', response: 'Code', createdAt: t0 }),
        makeRun({ id: 'run-rev', roleName: 'reviewer', status: 'done', response: '[MAJOR] DDD violation\nFAIL', createdAt: t1 }),
        makeRun({ id: 'run-dev-fix', roleName: 'developer', status: 'done', response: 'Fixed', createdAt: t2 }),
      ]);

      const result = await managerDecision.execute({ completedRunId: 'run-dev-fix' });

      expect(result.action).toBe('re_review_after_fix');
      expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ roleName: 'reviewer' }));
      expect(chatEngine.runPrompt).not.toHaveBeenCalled();
    });
  });

  describe('auto-start next pending task', () => {
    it('calls startNextPendingTask after merge_and_complete', async () => {
      const startNext = { execute: vi.fn().mockResolvedValue({ started: true }) };
      const md = new ManagerDecision({
        runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo,
        startNextPendingTask: startNext,
      });

      taskService.getTask.mockResolvedValue(makeTask({ projectId: 'proj-1' }));
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'reviewer', status: 'done' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ id: 'run-dev', roleName: 'developer', status: 'done', createdAt: new Date('2026-01-01') }),
        makeRun({ id: 'run-rev', roleName: 'reviewer', status: 'done', response: 'VERDICT: PASS\nSUMMARY: All good', createdAt: new Date('2026-01-02') }),
      ]);

      await md.execute({ completedRunId: 'run-rev' });

      expect(startNext.execute).toHaveBeenCalledWith({ projectId: 'proj-1' });
    });
  });

  describe('spawn_runs (PM LLM fallback)', () => {
    it('enqueues multiple runs from PM decision', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'failed' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'failed' }),
      ]);
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({
          action: 'spawn_runs',
          runs: [
            { role: 'reviewer-architecture', prompt: 'Review arch' },
            { role: 'reviewer-security', prompt: 'Review sec' },
          ],
        }),
      });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('spawn_runs');
      expect(runService.enqueue).toHaveBeenCalledTimes(2);
    });

    it('fails when runs array is empty', async () => {
      runRepo.findById.mockResolvedValue(makeRun({ roleName: 'analyst', status: 'failed' }));
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ roleName: 'analyst', status: 'failed' }),
      ]);
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({ action: 'spawn_runs', runs: [] }),
      });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('fail_task');
      expect(runService.enqueue).not.toHaveBeenCalled();
    });
  });
});

describe('parseManagerDecision', () => {
  it('parses valid JSON', () => {
    const result = parseManagerDecision('{"action":"spawn_run","role":"implementer","prompt":"code it"}');
    expect(result).toEqual({ action: 'spawn_run', role: 'implementer', prompt: 'code it' });
  });

  it('parses JSON wrapped in markdown code block', () => {
    const response = '```json\n{"action":"complete_task","summary":"Done"}\n```';
    const result = parseManagerDecision(response);
    expect(result).toEqual({ action: 'complete_task', summary: 'Done' });
  });

  it('returns null for non-JSON response', () => {
    expect(parseManagerDecision('I think we should continue')).toBeNull();
  });

  it('parses merge_and_complete action', () => {
    const json = JSON.stringify({ action: 'merge_and_complete', summary: 'Merged and done' });
    const result = parseManagerDecision(json);
    expect(result.action).toBe('merge_and_complete');
  });

  it('parses spawn_runs action with runs array', () => {
    const json = JSON.stringify({
      action: 'spawn_runs',
      runs: [{ role: 'reviewer', prompt: 'Review' }],
    });
    const result = parseManagerDecision(json);
    expect(result.action).toBe('spawn_runs');
    expect(result.runs).toHaveLength(1);
  });

  it('returns null for invalid action', () => {
    expect(parseManagerDecision('{"action":"invalid_action"}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseManagerDecision('{action: spawn_run}')).toBeNull();
  });
});

describe('buildManagerPrompt', () => {
  it('includes task info and last run delta', () => {
    const task = {
      title: 'Build API',
      description: 'REST endpoints',
      status: 'in_progress',
      revisionCount: 1,
      branchName: 'TP-1/build-api',
    };
    const runs = [
      { roleName: 'analyst', status: 'done', response: 'Analysis done', error: null, createdAt: new Date('2026-01-01') },
      { roleName: 'developer', status: 'failed', response: null, error: 'Compile error', createdAt: new Date('2026-01-02') },
    ];

    const prompt = buildManagerPrompt(task, runs);

    expect(prompt).toContain('Build API');
    expect(prompt).toContain('REST endpoints');
    expect(prompt).toContain('Ветка: TP-1/build-api');
    expect(prompt).toContain('Режим: auto');
    expect(prompt).toContain('Количество ревизий: 1');
    // Last run delta
    expect(prompt).toContain('[developer] status=failed');
    expect(prompt).toContain('Compile error');
  });

  it('includes merge_and_complete in JSON format description', () => {
    const task = { title: 'T', description: 'd', status: 'in_progress', revisionCount: 0 };
    const prompt = buildManagerPrompt(task, []);
    expect(prompt).toContain('merge_and_complete');
  });
});

describe('buildFixPrompt', () => {
  it('includes all blocking findings with severity and reviewer', () => {
    const task = { title: 'Build API', description: 'REST' };
    const findings = [
      { severity: 'CRITICAL', description: 'SQL injection', reviewerRole: 'reviewer' },
      { severity: 'MAJOR', description: 'Layer violation', reviewerRole: 'reviewer' },
    ];

    const prompt = buildFixPrompt(task, findings);

    expect(prompt).toContain('Build API');
    expect(prompt).toContain('[CRITICAL] SQL injection');
    expect(prompt).toContain('[MAJOR] Layer violation');
    expect(prompt).toContain('Фаза: fix');
  });
});

describe('buildReReviewPrompt', () => {
  it('includes task title and review instructions', () => {
    const task = { title: 'Build API', description: 'REST' };
    const prompt = buildReReviewPrompt(task);
    expect(prompt).toContain('Build API');
    expect(prompt).toContain('VERDICT');
  });
});

describe('ManagerDecision — research mode', () => {
  let managerDecision;
  let runService;
  let taskService;
  let chatEngine;
  let roleRegistry;
  let callbackSender;
  let runRepo;
  let startNextPendingTask;

  const t0 = new Date('2026-01-01');

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    title: 'Research topic X',
    description: 'Investigate X',
    status: 'in_progress',
    mode: 'research',
    revisionCount: 0,
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    projectId: 'proj-1',
    shortId: 'NF-15',
    ...overrides,
  });

  beforeEach(() => {
    runService = { enqueue: vi.fn().mockResolvedValue({ id: 'run-new', status: 'queued' }) };
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
      completeResearch: vi.fn().mockResolvedValue(undefined),
      failTask: vi.fn().mockResolvedValue(undefined),
    };
    chatEngine = {
      runPrompt: vi.fn().mockResolvedValue({
        response: JSON.stringify({ action: 'fail_task', reason: 'Analyst failed' }),
        sessionId: 'mgr-session',
      }),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'pm', timeoutMs: 600000 }),
      has: vi.fn().mockImplementation((name) => ['implementer', 'reviewer', 'pm'].includes(name)),
    };
    callbackSender = { send: vi.fn().mockResolvedValue({ ok: true }) };
    runRepo = { findById: vi.fn(), findByTaskId: vi.fn() };
    startNextPendingTask = { execute: vi.fn().mockResolvedValue({ started: false }) };

    managerDecision = new ManagerDecision({
      runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo,
      logger: { info: vi.fn(), error: vi.fn() },
      startNextPendingTask,
    });
  });

  it('completes task with research_done status after successful analyst run', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: '# Research\n\nFindings...', createdAt: t0 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-analyst' });

    expect(result.action).toBe('complete_task');
    expect(result.details.mode).toBe('research');
    expect(taskService.completeResearch).toHaveBeenCalledWith('task-1');
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('sends callback with type research_done', async () => {
    const analystResponse = '# Deep Research\n\nDetailed findings.';
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: analystResponse, createdAt: t0 },
    ]);

    await managerDecision.execute({ completedRunId: 'run-analyst' });

    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({
        type: 'research_done',
        mode: 'research',
        result: analystResponse,
        truncated: false,
      }),
      { chatId: 1 },
    );
  });

  it('also recognizes implementer as analyst in research mode', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-impl', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-impl', roleName: 'implementer', status: 'done', response: '# Research', createdAt: t0 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-impl' });

    expect(result.action).toBe('complete_task');
    expect(result.details.mode).toBe('research');
  });

  it('falls through to LLM if analyst failed', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'failed', response: null, error: 'timeout', createdAt: t0 },
    ]);

    await managerDecision.execute({ completedRunId: 'run-analyst' });

    expect(chatEngine.runPrompt).toHaveBeenCalled();
  });

  it('ignores research mode for mode=full tasks', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ mode: 'full' }));
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: 'Analysis', createdAt: t0 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-analyst' });

    // Should transition to developer (deterministic), not research_done
    expect(result.action).toBe('deterministic_transition');
  });

  it('calls tryStartNext after completing research task', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: 'Result', createdAt: t0 },
    ]);

    await managerDecision.execute({ completedRunId: 'run-analyst' });

    expect(startNextPendingTask.execute).toHaveBeenCalledWith({ projectId: 'proj-1' });
  });

  it('truncates callback result exceeding 50KB limit', async () => {
    const hugeResponse = 'A'.repeat(60 * 1024);
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: hugeResponse, createdAt: t0 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-analyst' });

    expect(result.details.truncated).toBe(true);
    const sentPayload = callbackSender.send.mock.calls[0][1];
    expect(sentPayload.truncated).toBe(true);
    expect(sentPayload.result).toContain('…[truncated]');
  });
});
