import { TaskStep } from './TaskStep.js';
import { InvalidTransitionError } from '../errors/InvalidTransitionError.js';

describe('TaskStep', () => {
  const defaults = { taskId: 't-1', roleName: 'developer', stepOrder: 1, promptTemplate: 'Build {{feature}}' };

  describe('create', () => {
    it('creates with pending status', () => {
      const step = TaskStep.create(defaults);
      expect(step.id).toBeDefined();
      expect(step.status).toBe('pending');
      expect(step.stepOrder).toBe(1);
      expect(step.promptTemplate).toBe('Build {{feature}}');
    });
  });

  describe('transitions', () => {
    it('pending → running → done', () => {
      const step = TaskStep.create(defaults);
      step.transitionTo('running');
      step.transitionTo('done');
      expect(step.status).toBe('done');
    });

    it('running → failed', () => {
      const step = TaskStep.create(defaults);
      step.transitionTo('running');
      step.transitionTo('failed');
      expect(step.status).toBe('failed');
    });

    it('rejects pending → done', () => {
      const step = TaskStep.create(defaults);
      expect(() => step.transitionTo('done')).toThrow(InvalidTransitionError);
    });
  });

  describe('serialization', () => {
    it('roundtrips through toRow/fromRow', () => {
      const step = TaskStep.create(defaults);
      const row = step.toRow();
      const restored = TaskStep.fromRow(row);
      expect(restored.id).toBe(step.id);
      expect(restored.taskId).toBe('t-1');
      expect(restored.roleName).toBe('developer');
    });
  });
});
