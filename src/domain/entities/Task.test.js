import { Task } from './Task.js';
import { InvalidTransitionError } from '../errors/InvalidTransitionError.js';

describe('Task', () => {
  const defaults = { projectId: 'proj-1', title: 'Test task', description: 'desc', callbackUrl: 'http://cb', callbackMeta: { chatId: 1 } };

  describe('create', () => {
    it('creates with pending status and zero revisions', () => {
      const task = Task.create(defaults);
      expect(task.id).toBeDefined();
      expect(task.status).toBe('pending');
      expect(task.revisionCount).toBe(0);
      expect(task.projectId).toBe('proj-1');
      expect(task.title).toBe('Test task');
    });
  });

  describe('state machine', () => {
    it('pending → in_progress', () => {
      const task = Task.create(defaults);
      task.transitionTo('in_progress');
      expect(task.status).toBe('in_progress');
    });

    it('pending → cancelled', () => {
      const task = Task.create(defaults);
      task.transitionTo('cancelled');
      expect(task.status).toBe('cancelled');
    });

    it('in_progress → waiting_reply → in_progress → done', () => {
      const task = Task.create(defaults);
      task.transitionTo('in_progress');
      task.transitionTo('waiting_reply');
      task.transitionTo('in_progress');
      task.transitionTo('done');
      expect(task.status).toBe('done');
    });

    it('in_progress → failed', () => {
      const task = Task.create(defaults);
      task.transitionTo('in_progress');
      task.transitionTo('failed');
      expect(task.status).toBe('failed');
    });

    it('in_progress → needs_escalation', () => {
      const task = Task.create(defaults);
      task.transitionTo('in_progress');
      task.transitionTo('needs_escalation');
      expect(task.status).toBe('needs_escalation');
    });

    it('needs_escalation → in_progress', () => {
      const task = Task.create(defaults);
      task.transitionTo('in_progress');
      task.transitionTo('needs_escalation');
      task.transitionTo('in_progress');
      expect(task.status).toBe('in_progress');
    });

    it('needs_escalation → cancelled', () => {
      const task = Task.create(defaults);
      task.transitionTo('in_progress');
      task.transitionTo('needs_escalation');
      task.transitionTo('cancelled');
      expect(task.status).toBe('cancelled');
    });

    it('rejects needs_escalation → done', () => {
      const task = Task.create(defaults);
      task.transitionTo('in_progress');
      task.transitionTo('needs_escalation');
      expect(() => task.transitionTo('done')).toThrow(InvalidTransitionError);
    });

    it('rejects invalid transition pending → done', () => {
      const task = Task.create(defaults);
      expect(() => task.transitionTo('done')).toThrow(InvalidTransitionError);
    });

    it('rejects transition from terminal state', () => {
      const task = Task.create(defaults);
      task.transitionTo('cancelled');
      expect(() => task.transitionTo('in_progress')).toThrow(InvalidTransitionError);
    });
  });

  describe('revisionCount', () => {
    it('increments', () => {
      const task = Task.create(defaults);
      task.incrementRevision();
      task.incrementRevision();
      expect(task.revisionCount).toBe(2);
    });
  });

  describe('seqNumber', () => {
    it('create accepts seqNumber', () => {
      const task = Task.create({ ...defaults, seqNumber: 5 });
      expect(task.seqNumber).toBe(5);
    });

    it('create defaults seqNumber to null', () => {
      const task = Task.create(defaults);
      expect(task.seqNumber).toBeNull();
    });
  });

  describe('serialization', () => {
    it('roundtrips through toRow/fromRow', () => {
      const task = Task.create(defaults);
      const row = task.toRow();
      const restored = Task.fromRow(row);
      expect(restored.id).toBe(task.id);
      expect(restored.projectId).toBe(task.projectId);
      expect(restored.status).toBe(task.status);
      expect(restored.callbackMeta).toEqual(task.callbackMeta);
    });

    it('roundtrips seqNumber through toRow/fromRow', () => {
      const task = Task.create({ ...defaults, seqNumber: 7 });
      const row = task.toRow();
      expect(row.seq_number).toBe(7);
      const restored = Task.fromRow(row);
      expect(restored.seqNumber).toBe(7);
    });

    it('projectPrefix defaults to null on create, shortId returns null without prefix', () => {
      const task = Task.create({ ...defaults, seqNumber: 3 });
      expect(task.projectPrefix).toBeNull();
      expect(task.shortId).toBeNull();
    });

    it('branchName defaults to null on create', () => {
      const task = Task.create({ ...defaults });
      expect(task.branchName).toBeNull();
    });

    it('mode defaults to full on create', () => {
      const task = Task.create(defaults);
      expect(task.mode).toBe('full');
    });

    it('create accepts mode: research', () => {
      const task = Task.create({ ...defaults, mode: 'research' });
      expect(task.mode).toBe('research');
    });

    it('roundtrips mode through toRow/fromRow', () => {
      const task = Task.create({ ...defaults, mode: 'research' });
      const row = task.toRow();
      expect(row.mode).toBe('research');
      const restored = Task.fromRow(row);
      expect(restored.mode).toBe('research');
    });

    it('fromRow defaults mode to full when absent', () => {
      const task = Task.create(defaults);
      const row = task.toRow();
      delete row.mode;
      const restored = Task.fromRow(row);
      expect(restored.mode).toBe('full');
    });

    it('supports backlog initial status', () => {
      const task = Task.create({ ...defaults, status: 'backlog' });
      expect(task.status).toBe('backlog');
    });

    it('backlog can transition to pending', () => {
      const task = Task.create({ ...defaults, status: 'backlog' });
      task.transitionTo('pending');
      expect(task.status).toBe('pending');
    });

    it('backlog can transition to cancelled', () => {
      const task = Task.create({ ...defaults, status: 'backlog' });
      task.transitionTo('cancelled');
      expect(task.status).toBe('cancelled');
    });
  });
});
