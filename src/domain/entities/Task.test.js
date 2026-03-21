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
  });
});
