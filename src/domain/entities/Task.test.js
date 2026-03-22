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
    it('backlog → pending', () => {
      const task = Task.create({ ...defaults, status: 'backlog' });
      task.transitionTo('pending');
      expect(task.status).toBe('pending');
    });

    it('backlog → cancelled', () => {
      const task = Task.create({ ...defaults, status: 'backlog' });
      task.transitionTo('cancelled');
      expect(task.status).toBe('cancelled');
    });

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

    it('roundtrips branchName through toRow/fromRow', () => {
      const task = Task.create(defaults);
      task.branchName = 'NF-5/my-feature';
      const row = task.toRow();
      expect(row.branch_name).toBe('NF-5/my-feature');
      const restored = Task.fromRow(row);
      expect(restored.branchName).toBe('NF-5/my-feature');
    });

    it('branchName defaults to null', () => {
      const task = Task.create(defaults);
      expect(task.branchName).toBeNull();
    });
  });

  describe('generateBranchName', () => {
    it('generates slug from shortId and title', () => {
      expect(Task.generateBranchName('NF-5', 'Add queue and git branches')).toBe('NF-5/add-queue-and-git-branches');
    });

    it('strips special characters', () => {
      expect(Task.generateBranchName('BOT-3', 'Fix: slash/backslash!')).toBe('BOT-3/fix-slashbackslash');
    });

    it('trims slug to 50 chars', () => {
      const long = 'A'.repeat(60);
      const result = Task.generateBranchName('NF-1', long);
      expect(result.split('/')[1].length).toBeLessThanOrEqual(50);
    });
  });
});
