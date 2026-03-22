import { Run } from './Run.js';
import { InvalidTransitionError } from '../errors/InvalidTransitionError.js';

describe('Run', () => {
  const defaults = { taskId: 't-1', stepId: 's-1', roleName: 'developer', prompt: 'do stuff', callbackUrl: 'http://cb', callbackMeta: { chatId: 99 } };

  describe('create', () => {
    it('creates with queued status', () => {
      const run = Run.create(defaults);
      expect(run.id).toBeDefined();
      expect(run.status).toBe('queued');
      expect(run.response).toBeNull();
      expect(run.startedAt).toBeNull();
    });
  });

  describe('lifecycle', () => {
    it('queued → running → done with duration', () => {
      const run = Run.create(defaults);
      run.start('session-1');
      expect(run.status).toBe('running');
      expect(run.sessionId).toBe('session-1');
      expect(run.startedAt).toBeInstanceOf(Date);

      run.complete('result text');
      expect(run.status).toBe('done');
      expect(run.response).toBe('result text');
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('running → failed', () => {
      const run = Run.create(defaults);
      run.start('s-1');
      run.fail('something broke');
      expect(run.status).toBe('failed');
      expect(run.error).toBe('something broke');
    });

    it('running → timeout', () => {
      const run = Run.create(defaults);
      run.start('s-1');
      run.markTimeout();
      expect(run.status).toBe('timeout');
    });

    it('running → interrupted', () => {
      const run = Run.create(defaults);
      run.start('s-1');
      run.interrupt();
      expect(run.status).toBe('interrupted');
    });

    it('queued → cancelled', () => {
      const run = Run.create(defaults);
      run.transitionTo('cancelled');
      expect(run.status).toBe('cancelled');
    });

    it('rejects queued → done', () => {
      const run = Run.create(defaults);
      expect(() => run.transitionTo('done')).toThrow(InvalidTransitionError);
    });

    it('rejects transition from terminal state', () => {
      const run = Run.create(defaults);
      run.start('s-1');
      run.complete('ok');
      expect(() => run.start('s-2')).toThrow(InvalidTransitionError);
    });
  });

  describe('serialization', () => {
    it('roundtrips through toRow/fromRow', () => {
      const run = Run.create(defaults);
      run.start('s-1');
      const row = run.toRow();
      const restored = Run.fromRow(row);
      expect(restored.id).toBe(run.id);
      expect(restored.roleName).toBe('developer');
      expect(restored.sessionId).toBe('s-1');
      expect(restored.status).toBe('running');
      expect(restored.callbackMeta).toEqual({ chatId: 99 });
    });
  });
});
