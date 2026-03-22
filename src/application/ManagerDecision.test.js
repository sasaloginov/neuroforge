import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManagerDecision, parseManagerDecision, buildManagerPrompt, buildFixPrompt, buildReReviewPrompt } from './ManagerDecision.js';
import { RunNotFoundError } from '../domain/errors/RunNotFoundError.js';
import { TaskNotFoundError } from '../domain/errors/TaskNotFoundError.js';
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
    };
    chatEngine = {
      runPrompt: vi.fn().mockResolvedValue({
        response: JSON.stringify({ action: 'spawn_run', role: 'developer', prompt: 'Implement the feature' }),
        sessionId: 'mgr-session',
      }),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'manager', timeoutMs: 600000 }),
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

  it('spawn_run: enqueues new developer run', async () => {
    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('spawn_run');
    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      roleName: 'developer',
      prompt: 'Implement the feature',
    }));
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'progress', stage: 'developer' }),
      { chatId: 1 },
    );
  });

  it('ask_owner: transitions task to waiting_reply and sends question callback', async () => {
    chatEngine.runPrompt.mockResolvedValue({
      response: JSON.stringify({ action: 'ask_owner', question: 'Which DB to use?', context: 'Need decision' }),
    });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('ask_owner');
    expect(taskService.requestReply).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'question', question: 'Which DB to use?' }),
      { chatId: 1 },
    );
  });

  it('complete_task: completes task and sends done callback', async () => {
    chatEngine.runPrompt.mockResolvedValue({
      response: JSON.stringify({ action: 'complete_task', summary: 'All done!' }),
    });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('complete_task');
    expect(taskService.completeTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'done', summary: 'All done!' }),
      { chatId: 1 },
    );
  });

  it('fail_task: fails task and sends failure callback', async () => {
    chatEngine.runPrompt.mockResolvedValue({
      response: JSON.stringify({ action: 'fail_task', reason: 'Impossible requirement' }),
    });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(taskService.failTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'failed', error: 'Impossible requirement' }),
      { chatId: 1 },
    );
  });

  it('waits when parallel runs are still pending', async () => {
    runRepo.findByTaskId.mockResolvedValue([
      makeRun({ id: 'run-1', status: 'done' }),
      makeRun({ id: 'run-2', status: 'running' }),
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result).toEqual({ action: 'waiting', details: { pendingCount: 1 } });
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('fails task when manager returns unparseable response', async () => {
    chatEngine.runPrompt.mockResolvedValue({ response: 'I am not sure what to do next' });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(taskService.failTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'failed', error: 'Manager returned unparseable response' }),
      { chatId: 1 },
    );
  });

  it('fails task when manager returns no JSON at all', async () => {
    chatEngine.runPrompt.mockResolvedValue({ response: 'No JSON here' });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(taskService.failTask).toHaveBeenCalled();
  });

  it('fails task on revision limit exceeded', async () => {
    // Already has a completed developer run
    runRepo.findByTaskId.mockResolvedValue([
      makeRun({ id: 'run-1', roleName: 'developer', status: 'done' }),
    ]);
    chatEngine.runPrompt.mockResolvedValue({
      response: JSON.stringify({ action: 'spawn_run', role: 'developer', prompt: 'Fix the code' }),
    });
    taskService.incrementRevision.mockRejectedValue(new RevisionLimitError('task-1', 3));

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(result.details.reason).toContain('Revision limit');
  });

  it('skips when task is already cancelled', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'cancelled' }));

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('skipped');
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('skips when task is already done', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'done' }));

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('skipped');
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('skips when task is already failed', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'failed' }));

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('skipped');
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('fails task when spawn_run specifies unknown role', async () => {
    chatEngine.runPrompt.mockResolvedValue({
      response: JSON.stringify({ action: 'spawn_run', role: 'nonexistent', prompt: 'Do something' }),
    });
    roleRegistry.get.mockImplementation((name) => {
      if (name === 'manager') return { name: 'manager', timeoutMs: 600000 };
      throw new RoleNotFoundError(name);
    });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(taskService.failTask).toHaveBeenCalledWith('task-1');
  });

  it('throws RunNotFoundError when run does not exist', async () => {
    runRepo.findById.mockResolvedValue(null);

    await expect(managerDecision.execute({ completedRunId: 'nonexistent' })).rejects.toThrow(RunNotFoundError);
  });

  it('throws InvalidStateError when run is not in terminal state', async () => {
    runRepo.findById.mockResolvedValue(makeRun({ status: 'running' }));

    await expect(managerDecision.execute({ completedRunId: 'run-1' })).rejects.toThrow(InvalidStateError);
  });

  it('fails task when chatEngine throws during manager execution', async () => {
    chatEngine.runPrompt.mockRejectedValue(new Error('Manager agent crashed'));

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(taskService.failTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'failed', error: expect.stringContaining('Manager agent failed') }),
      { chatId: 1 },
    );
  });

  it('does not send callback when callbackUrl is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));

    await managerDecision.execute({ completedRunId: 'run-1' });

    expect(callbackSender.send).not.toHaveBeenCalled();
  });

  describe('spawn_runs', () => {
    it('enqueues all 3 reviewer runs from runs array', async () => {
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({
          action: 'spawn_runs',
          runs: [
            { role: 'reviewer-architecture', prompt: 'Review arch' },
            { role: 'reviewer-business', prompt: 'Review biz' },
            { role: 'reviewer-security', prompt: 'Review sec' },
          ],
        }),
      });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('spawn_runs');
      expect(runService.enqueue).toHaveBeenCalledTimes(3);
      expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ roleName: 'reviewer-architecture' }));
      expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ roleName: 'reviewer-business' }));
      expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ roleName: 'reviewer-security' }));

      // callbackMeta must be passed to every enqueued run
      for (const call of runService.enqueue.mock.calls) {
        expect(call[0].callbackMeta).toEqual({ chatId: 1 });
      }
    });

    it('sends single progress callback with combined stage name', async () => {
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({
          action: 'spawn_runs',
          runs: [
            { role: 'reviewer-architecture', prompt: 'Review arch' },
            { role: 'reviewer-security', prompt: 'Review sec' },
          ],
        }),
      });

      await managerDecision.execute({ completedRunId: 'run-1' });

      expect(callbackSender.send).toHaveBeenCalledWith(
        'https://example.com/cb',
        expect.objectContaining({
          type: 'progress',
          stage: 'reviewer-architecture+reviewer-security',
          message: expect.stringContaining('Параллельный запуск'),
        }),
        { chatId: 1 },
      );
    });

    it('validates all roles exist before enqueuing any (fail-fast)', async () => {
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({
          action: 'spawn_runs',
          runs: [
            { role: 'reviewer-architecture', prompt: 'Review' },
            { role: 'nonexistent', prompt: 'Fail' },
          ],
        }),
      });
      roleRegistry.get.mockImplementation((name) => {
        if (name === 'manager' || name === 'reviewer-architecture') return { name, timeoutMs: 600000 };
        throw new RoleNotFoundError(name);
      });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('fail_task');
      expect(runService.enqueue).not.toHaveBeenCalled();
    });

    it('fails when runs array is empty', async () => {
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({ action: 'spawn_runs', runs: [] }),
      });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('fail_task');
      expect(runService.enqueue).not.toHaveBeenCalled();
    });

    it('fails when runs is not an array', async () => {
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({ action: 'spawn_runs', runs: 'not-array' }),
      });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('fail_task');
      expect(runService.enqueue).not.toHaveBeenCalled();
    });

    it('fails when run item missing role/prompt', async () => {
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({
          action: 'spawn_runs',
          runs: [{ role: 'developer' }], // missing prompt
        }),
      });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });

      expect(result.action).toBe('fail_task');
      expect(runService.enqueue).not.toHaveBeenCalled();
    });

    it('increments revision when runs include developer with prior dev run', async () => {
      runRepo.findByTaskId.mockResolvedValue([
        makeRun({ id: 'run-1', roleName: 'developer', status: 'done' }),
      ]);
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({
          action: 'spawn_runs',
          runs: [
            { role: 'developer', prompt: 'Fix code' },
            { role: 'tester', prompt: 'Test code' },
          ],
        }),
      });

      await managerDecision.execute({ completedRunId: 'run-1' });

      expect(taskService.incrementRevision).toHaveBeenCalledWith('task-1');
    });

    it('does not increment revision when no developer in runs', async () => {
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({
          action: 'spawn_runs',
          runs: [
            { role: 'reviewer-architecture', prompt: 'Review' },
            { role: 'reviewer-security', prompt: 'Review' },
          ],
        }),
      });

      await managerDecision.execute({ completedRunId: 'run-1' });

      expect(taskService.incrementRevision).not.toHaveBeenCalled();
    });

    it('does not send callback when callbackUrl is null', async () => {
      taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({
          action: 'spawn_runs',
          runs: [{ role: 'tester', prompt: 'Test' }],
        }),
      });

      await managerDecision.execute({ completedRunId: 'run-1' });

      expect(runService.enqueue).toHaveBeenCalledTimes(1);
      expect(callbackSender.send).not.toHaveBeenCalled();
    });

    it('works alongside existing spawn_run (backward compat)', async () => {
      // spawn_run still works
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({ action: 'spawn_run', role: 'developer', prompt: 'Code it' }),
      });

      const result = await managerDecision.execute({ completedRunId: 'run-1' });
      expect(result.action).toBe('spawn_run');
      expect(runService.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('auto-start next pending task', () => {
    it('calls startNextPendingTask after complete_task', async () => {
      const startNext = { execute: vi.fn().mockResolvedValue({ started: true }) };
      const md = new ManagerDecision({
        runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo,
        startNextPendingTask: startNext,
      });

      taskService.getTask.mockResolvedValue(makeTask({ projectId: 'proj-1' }));
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({ action: 'complete_task', summary: 'Done' }),
      });

      await md.execute({ completedRunId: 'run-1' });

      expect(startNext.execute).toHaveBeenCalledWith({ projectId: 'proj-1' });
    });

    it('calls startNextPendingTask after fail_task', async () => {
      const startNext = { execute: vi.fn().mockResolvedValue({ started: false }) };
      const md = new ManagerDecision({
        runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo,
        startNextPendingTask: startNext,
      });

      taskService.getTask.mockResolvedValue(makeTask({ projectId: 'proj-1' }));
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({ action: 'fail_task', reason: 'Broken' }),
      });

      await md.execute({ completedRunId: 'run-1' });

      expect(startNext.execute).toHaveBeenCalledWith({ projectId: 'proj-1' });
    });

    it('does not fail if startNextPendingTask throws', async () => {
      const startNext = { execute: vi.fn().mockRejectedValue(new Error('oops')) };
      const md = new ManagerDecision({
        runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo,
        startNextPendingTask: startNext, logger: { info: vi.fn(), error: vi.fn() },
      });

      taskService.getTask.mockResolvedValue(makeTask({ projectId: 'proj-1' }));
      chatEngine.runPrompt.mockResolvedValue({
        response: JSON.stringify({ action: 'complete_task', summary: 'Ok' }),
      });

      const result = await md.execute({ completedRunId: 'run-1' });
      expect(result.action).toBe('complete_task');
    });
  });
});

describe('parseManagerDecision', () => {
  it('parses valid JSON', () => {
    const result = parseManagerDecision('{"action":"spawn_run","role":"developer","prompt":"code it"}');
    expect(result).toEqual({ action: 'spawn_run', role: 'developer', prompt: 'code it' });
  });

  it('parses JSON wrapped in markdown code block', () => {
    const response = '```json\n{"action":"complete_task","summary":"Done"}\n```';
    const result = parseManagerDecision(response);
    expect(result).toEqual({ action: 'complete_task', summary: 'Done' });
  });

  it('returns null for non-JSON response', () => {
    expect(parseManagerDecision('I think we should continue')).toBeNull();
  });

  it('parses spawn_runs action with runs array', () => {
    const json = JSON.stringify({
      action: 'spawn_runs',
      runs: [{ role: 'reviewer-architecture', prompt: 'Review arch' }, { role: 'reviewer-security', prompt: 'Review sec' }],
    });
    const result = parseManagerDecision(json);
    expect(result.action).toBe('spawn_runs');
    expect(result.runs).toHaveLength(2);
  });

  it('parses spawn_runs wrapped in markdown code block', () => {
    const response = '```json\n{"action":"spawn_runs","runs":[{"role":"tester","prompt":"Run tests"}]}\n```';
    const result = parseManagerDecision(response);
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
  it('includes task info and run history', () => {
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
    expect(prompt).toContain('[analyst] status=done');
    expect(prompt).toContain('Analysis done');
    expect(prompt).toContain('[developer] status=failed');
    expect(prompt).toContain('Compile error');
    expect(prompt).toContain('Количество ревизий: 1');
  });

  it('includes spawn_runs in JSON format description', () => {
    const task = { title: 'T', description: 'd', status: 'in_progress', revisionCount: 0 };
    const prompt = buildManagerPrompt(task, []);
    expect(prompt).toContain('spawn_runs');
  });

  it('shows "не назначена" when branchName is null', () => {
    const task = { title: 'T', description: 'd', status: 'in_progress', revisionCount: 0, branchName: null };
    const prompt = buildManagerPrompt(task, []);
    expect(prompt).toContain('Ветка: не назначена');
  });
});

describe('buildFixPrompt', () => {
  it('includes all blocking findings with severity and reviewer', () => {
    const task = { title: 'Build API', description: 'REST' };
    const findings = [
      { severity: 'CRITICAL', description: 'SQL injection', reviewerRole: 'reviewer-security' },
      { severity: 'MAJOR', description: 'Layer violation', reviewerRole: 'reviewer-architecture' },
    ];

    const prompt = buildFixPrompt(task, findings);

    expect(prompt).toContain('Build API');
    expect(prompt).toContain('[CRITICAL] SQL injection');
    expect(prompt).toContain('reviewer-security');
    expect(prompt).toContain('[MAJOR] Layer violation');
    expect(prompt).toContain('reviewer-architecture');
  });
});

describe('buildReReviewPrompt', () => {
  it('includes task title and review instructions', () => {
    const task = { title: 'Build API', description: 'REST' };

    const prompt = buildReReviewPrompt(task);

    expect(prompt).toContain('Build API');
    expect(prompt).toContain('VERDICT');
    expect(prompt).toContain('FINDINGS');
  });
});

describe('ManagerDecision — review severity handling', () => {
  let managerDecision;
  let runService;
  let taskService;
  let chatEngine;
  let roleRegistry;
  let callbackSender;
  let runRepo;

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    title: 'Build feature X',
    description: 'Build a REST API',
    status: 'in_progress',
    revisionCount: 0,
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    ...overrides,
  });

  const t0 = new Date('2026-01-01');
  const t1 = new Date('2026-01-02');
  const t2 = new Date('2026-01-03');

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
    };
    chatEngine = {
      runPrompt: vi.fn().mockResolvedValue({
        response: JSON.stringify({ action: 'spawn_run', role: 'tester', prompt: 'Run tests' }),
        sessionId: 'mgr-session',
      }),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'manager', timeoutMs: 600000 }),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };
    runRepo = {
      findById: vi.fn(),
      findByTaskId: vi.fn(),
    };

    managerDecision = new ManagerDecision({ runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo });
  });

  it('triggers revision cycle when reviewers find blocking issues (revisionCount < 3)', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-rev', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-dev', roleName: 'developer', status: 'done', response: 'Code written', createdAt: t0 },
      { id: 'run-rev-arch', roleName: 'reviewer-architecture', status: 'done', response: '[MAJOR] DDD layer violation\nFAIL', createdAt: t1 },
      { id: 'run-rev-sec', roleName: 'reviewer-security', status: 'done', response: '[MINOR] Consider adding rate limit\nPASS', createdAt: t2 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-rev' });

    expect(result.action).toBe('revision_cycle');
    expect(taskService.incrementRevision).toHaveBeenCalledWith('task-1');
    // Developer fix run enqueued
    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ roleName: 'developer' }));
    // Only reviewer-architecture re-review (not security, which had no blocking issues)
    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ roleName: 'reviewer-architecture' }));
    expect(runService.enqueue).not.toHaveBeenCalledWith(expect.objectContaining({ roleName: 'reviewer-security' }));
    // Progress callback sent
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'progress', stage: 'revision' }),
      { chatId: 1 },
    );
    // Manager LLM NOT called
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('escalates when blocking issues and revisionCount >= 3', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ revisionCount: 3 }));
    runRepo.findById.mockResolvedValue({ id: 'run-rev', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-dev', roleName: 'developer', status: 'done', response: 'Code', createdAt: t0 },
      { id: 'run-rev', roleName: 'reviewer-security', status: 'done', response: '[CRITICAL] SQL injection\nFAIL', createdAt: t1 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-rev' });

    expect(result.action).toBe('needs_escalation');
    expect(taskService.escalateTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'needs_escalation', taskId: 'task-1' }),
      { chatId: 1 },
    );
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
    expect(runService.enqueue).not.toHaveBeenCalled();
  });

  it('sends tech_debt callback for minor-only findings and continues to LLM', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-rev', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-dev', roleName: 'developer', status: 'done', response: 'Code', createdAt: t0 },
      { id: 'run-rev-arch', roleName: 'reviewer-architecture', status: 'done', response: '[MINOR] Style nit\nPASS', createdAt: t1 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-rev' });

    // tech_debt callback sent
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'tech_debt', taskId: 'task-1' }),
      { chatId: 1 },
    );
    // Manager LLM still called (returns spawn_run tester from mock)
    expect(chatEngine.runPrompt).toHaveBeenCalled();
    expect(result.action).toBe('spawn_run');
  });

  it('falls through to LLM when no reviewer runs after last dev run', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-dev', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-dev', roleName: 'developer', status: 'done', response: 'Code', createdAt: t0 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-dev' });

    // Manager LLM called (no review findings to handle)
    expect(chatEngine.runPrompt).toHaveBeenCalled();
    expect(result.action).toBe('spawn_run');
  });

  it('falls through to LLM when no dev run exists', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-1', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-1', roleName: 'analyst', status: 'done', response: 'Analysis', createdAt: t0 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(chatEngine.runPrompt).toHaveBeenCalled();
  });

  it('ignores reviewer runs that are not status=done', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-rev', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-dev', roleName: 'developer', status: 'done', response: 'Code', createdAt: t0 },
      { id: 'run-rev', roleName: 'reviewer-architecture', status: 'failed', response: null, error: 'timeout', createdAt: t1 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-rev' });

    // No reviewer runs with done status → falls through to LLM
    expect(chatEngine.runPrompt).toHaveBeenCalled();
  });

  it('handles review findings from multiple reviewers with mixed severity', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-rev', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-dev', roleName: 'developer', status: 'done', response: 'Code', createdAt: t0 },
      { id: 'run-arch', roleName: 'reviewer-architecture', status: 'done', response: '[CRITICAL] Layer break\nFAIL', createdAt: t1 },
      { id: 'run-biz', roleName: 'reviewer-business', status: 'done', response: '[MINOR] Edge case\nPASS', createdAt: t1 },
      { id: 'run-sec', roleName: 'reviewer-security', status: 'done', response: '[HIGH] XSS issue\nFAIL', createdAt: t2 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-rev' });

    expect(result.action).toBe('revision_cycle');
    expect(result.details.reviewersWithBlockingIssues).toEqual(
      expect.arrayContaining(['reviewer-architecture', 'reviewer-security']),
    );
    expect(result.details.reviewersWithBlockingIssues).not.toContain('reviewer-business');
    // 3 enqueue calls: developer + 2 reviewers with blocking
    expect(runService.enqueue).toHaveBeenCalledTimes(3);
  });

  it('does not send tech_debt callback when callbackUrl is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));
    runRepo.findById.mockResolvedValue({ id: 'run-rev', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-dev', roleName: 'developer', status: 'done', response: 'Code', createdAt: t0 },
      { id: 'run-rev', roleName: 'reviewer-architecture', status: 'done', response: '[MINOR] Nit\nPASS', createdAt: t1 },
    ]);

    await managerDecision.execute({ completedRunId: 'run-rev' });

    // No callback sent (url is null), but LLM still called
    expect(callbackSender.send).not.toHaveBeenCalledWith(
      null,
      expect.anything(),
      expect.anything(),
    );
    expect(chatEngine.runPrompt).toHaveBeenCalled();
  });

  it('does not send escalation callback when callbackUrl is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null, revisionCount: 3 }));
    runRepo.findById.mockResolvedValue({ id: 'run-rev', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-dev', roleName: 'developer', status: 'done', response: 'Code', createdAt: t0 },
      { id: 'run-rev', roleName: 'reviewer-security', status: 'done', response: '[CRITICAL] Vuln\nFAIL', createdAt: t1 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-rev' });

    expect(result.action).toBe('needs_escalation');
    expect(taskService.escalateTask).toHaveBeenCalled();
    expect(callbackSender.send).not.toHaveBeenCalled();
  });

  it('falls through when all reviews pass with no findings', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-rev', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-dev', roleName: 'developer', status: 'done', response: 'Code', createdAt: t0 },
      { id: 'run-arch', roleName: 'reviewer-architecture', status: 'done', response: 'PASS', createdAt: t1 },
      { id: 'run-sec', roleName: 'reviewer-security', status: 'done', response: 'PASS', createdAt: t1 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-rev' });

    // No findings → falls through to LLM
    expect(chatEngine.runPrompt).toHaveBeenCalled();
  });

  it('only considers reviewer runs after the last dev run', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-rev2', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-rev-old', roleName: 'reviewer-security', status: 'done', response: '[CRITICAL] Old vuln\nFAIL', createdAt: t0 },
      { id: 'run-dev', roleName: 'developer', status: 'done', response: 'Fixed', createdAt: t1 },
      { id: 'run-rev2', roleName: 'reviewer-security', status: 'done', response: 'PASS', createdAt: t2 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-rev2' });

    // Old reviewer run before dev run is ignored. New review says PASS → falls through to LLM
    expect(chatEngine.runPrompt).toHaveBeenCalled();
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
    runService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'run-new', status: 'queued' }),
    };
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
      completeTask: vi.fn().mockResolvedValue(undefined),
      failTask: vi.fn().mockResolvedValue(undefined),
    };
    chatEngine = {
      runPrompt: vi.fn().mockResolvedValue({
        response: JSON.stringify({ action: 'fail_task', reason: 'Analyst failed' }),
        sessionId: 'mgr-session',
      }),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'manager', timeoutMs: 600000 }),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };
    runRepo = {
      findById: vi.fn(),
      findByTaskId: vi.fn(),
    };
    startNextPendingTask = {
      execute: vi.fn().mockResolvedValue({ started: false }),
    };

    managerDecision = new ManagerDecision({
      runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo,
      logger: { info: vi.fn(), error: vi.fn() },
      startNextPendingTask,
    });
  });

  it('completes task after successful analyst run without calling LLM', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: '# Research\n\nFindings...', createdAt: t0 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-analyst' });

    expect(result.action).toBe('complete_task');
    expect(result.details.mode).toBe('research');
    expect(taskService.completeTask).toHaveBeenCalledWith('task-1');
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('sends callback with result field containing analyst response', async () => {
    const analystResponse = '# Deep Research\n\nDetailed findings about topic X.';
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: analystResponse, createdAt: t0 },
    ]);

    await managerDecision.execute({ completedRunId: 'run-analyst' });

    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({
        type: 'done',
        mode: 'research',
        result: analystResponse,
        summary: 'Исследование завершено',
        taskId: 'task-1',
        shortId: 'NF-15',
      }),
      { chatId: 1 },
    );
  });

  it('truncates result if analyst response > 50KB', async () => {
    const longResponse = 'x'.repeat(60_000);
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: longResponse, createdAt: t0 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-analyst' });

    expect(result.details.resultLength).toBe(60_000);
    const sentPayload = callbackSender.send.mock.calls[0][1];
    expect(sentPayload.result.length).toBeLessThanOrEqual(50_000 + 20);
    expect(sentPayload.result).toContain('[...truncated]');
  });

  it('falls through to LLM if analyst failed', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'failed', response: null, error: 'timeout', createdAt: t0 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-analyst' });

    // Should fall through to LLM manager
    expect(chatEngine.runPrompt).toHaveBeenCalled();
    expect(taskService.completeTask).not.toHaveBeenCalled();
  });

  it('ignores research mode for mode=full tasks', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ mode: 'full' }));
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: 'Analysis', createdAt: t0 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-analyst' });

    // Should fall through to LLM manager for full mode
    expect(chatEngine.runPrompt).toHaveBeenCalled();
  });

  it('calls tryStartNext after completing research task', async () => {
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: 'Result', createdAt: t0 },
    ]);

    await managerDecision.execute({ completedRunId: 'run-analyst' });

    expect(startNextPendingTask.execute).toHaveBeenCalledWith({ projectId: 'proj-1' });
  });

  it('does not send callback when callbackUrl is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));
    runRepo.findById.mockResolvedValue({ id: 'run-analyst', taskId: 'task-1', status: 'done' });
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: 'Result', createdAt: t0 },
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-analyst' });

    expect(result.action).toBe('complete_task');
    expect(callbackSender.send).not.toHaveBeenCalled();
  });
});
