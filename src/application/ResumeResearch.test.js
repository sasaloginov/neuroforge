import { ResumeResearch } from './ResumeResearch.js';
import { InvalidStateError } from '../domain/errors/InvalidStateError.js';
import { ValidationError } from '../domain/errors/ValidationError.js';

describe('ResumeResearch', () => {
  let resumeResearch;
  let taskService;
  let runService;
  let runRepo;
  let taskRepo;
  let projectRepo;
  let roleRegistry;
  let callbackSender;

  const t0 = new Date('2026-01-01');

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    title: 'Research topic X',
    description: 'Investigate X',
    status: 'research_done',
    mode: 'research',
    revisionCount: 0,
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    projectId: 'proj-1',
    seqNumber: 17,
    branchName: 'NF-17/research-topic-x',
    shortId: 'NF-17',
    ...overrides,
  });

  beforeEach(() => {
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
      updateMode: vi.fn().mockResolvedValue(undefined),
    };
    runService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'run-dev', status: 'queued' }),
    };
    runRepo = {
      findByTaskId: vi.fn().mockResolvedValue([
        { id: 'run-analyst', roleName: 'analyst', status: 'done', response: '# Research Results\n\nFindings about X.', createdAt: t0 },
      ]),
    };
    taskRepo = {
      activateIfNoActive: vi.fn().mockResolvedValue(true),
    };
    projectRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'proj-1', prefix: 'NF' }),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'implementer' }),
      has: vi.fn().mockImplementation((name) => name === 'implementer'),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };

    resumeResearch = new ResumeResearch({
      taskService, runService, runRepo, taskRepo, projectRepo,
      roleRegistry, callbackSender, logger: { info: vi.fn(), error: vi.fn() },
    });
  });

  it('resumes research_done task → enqueues implementer with instruction', async () => {
    const result = await resumeResearch.execute({
      taskId: 'task-1',
      instruction: 'Передай в разработку',
    });

    expect(result.taskId).toBe('task-1');
    expect(result.status).toBe('in_progress');
    expect(result.shortId).toBe('NF-17');

    // Mode updated to full
    expect(taskService.updateMode).toHaveBeenCalledWith('task-1', 'full');

    // Implementer enqueued (developer phase)
    expect(runService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        roleName: 'implementer',
      }),
    );

    // Prompt includes instruction and research context
    const prompt = runService.enqueue.mock.calls[0][0].prompt;
    expect(prompt).toContain('Передай в разработку');
    expect(prompt).toContain('Research Results');

    // Callback sent
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({
        type: 'progress',
        stage: 'resumed',
        taskId: 'task-1',
      }),
      { chatId: 1 },
    );
  });

  it('falls back to developer role when implementer not available', async () => {
    roleRegistry.has.mockReturnValue(false);
    roleRegistry.get.mockReturnValue({ name: 'developer' });

    await resumeResearch.execute({
      taskId: 'task-1',
      instruction: 'Go',
    });

    expect(runService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ roleName: 'developer' }),
    );
  });

  it('throws InvalidStateError when task is not research_done', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'in_progress' }));

    await expect(
      resumeResearch.execute({ taskId: 'task-1', instruction: 'Go' }),
    ).rejects.toThrow(InvalidStateError);

    expect(taskRepo.activateIfNoActive).not.toHaveBeenCalled();
  });

  it('throws InvalidStateError when slot is occupied', async () => {
    taskRepo.activateIfNoActive.mockResolvedValue(false);

    await expect(
      resumeResearch.execute({ taskId: 'task-1', instruction: 'Go' }),
    ).rejects.toThrow('Cannot resume: another task is active');
  });

  it('throws ValidationError when instruction is empty', async () => {
    await expect(
      resumeResearch.execute({ taskId: 'task-1', instruction: '' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when instruction is whitespace', async () => {
    await expect(
      resumeResearch.execute({ taskId: 'task-1', instruction: '   ' }),
    ).rejects.toThrow(ValidationError);
  });

  it('includes previous analyst response in prompt', async () => {
    const analystResponse = '# Detailed Analysis\n\nLong research findings about the topic.';
    runRepo.findByTaskId.mockResolvedValue([
      { id: 'run-analyst', roleName: 'analyst', status: 'done', response: analystResponse, createdAt: t0 },
    ]);

    await resumeResearch.execute({
      taskId: 'task-1',
      instruction: 'Implement based on research',
    });

    const prompt = runService.enqueue.mock.calls[0][0].prompt;
    expect(prompt).toContain('Detailed Analysis');
    expect(prompt).toContain('Long research findings');
    expect(prompt).toContain('Implement based on research');
  });

  it('works without callbackUrl', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));

    const result = await resumeResearch.execute({
      taskId: 'task-1',
      instruction: 'Go ahead',
    });

    expect(result.status).toBe('in_progress');
    expect(callbackSender.send).not.toHaveBeenCalled();
  });

  it('works without previous analyst runs', async () => {
    runRepo.findByTaskId.mockResolvedValue([]);

    const result = await resumeResearch.execute({
      taskId: 'task-1',
      instruction: 'Start development',
    });

    expect(result.status).toBe('in_progress');
    const prompt = runService.enqueue.mock.calls[0][0].prompt;
    expect(prompt).toContain('Start development');
    expect(prompt).not.toContain('Результаты предыдущего исследования');
  });

  it('atomically activates task via activateIfNoActive', async () => {
    await resumeResearch.execute({
      taskId: 'task-1',
      instruction: 'Go',
    });

    expect(taskRepo.activateIfNoActive).toHaveBeenCalledWith('task-1', 'proj-1', 'research_done');
  });
});
