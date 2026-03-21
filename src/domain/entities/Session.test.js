import { Session } from './Session.js';
import { InvalidTransitionError } from '../errors/InvalidTransitionError.js';

describe('Session', () => {
  describe('create', () => {
    it('creates with active status', () => {
      const session = Session.create({ projectId: 'p-1', roleName: 'developer', cliSessionId: 'cli-1' });
      expect(session.id).toBeDefined();
      expect(session.status).toBe('active');
      expect(session.projectId).toBe('p-1');
      expect(session.roleName).toBe('developer');
    });
  });

  describe('transitions', () => {
    it('active → closed', () => {
      const session = Session.create({ projectId: 'p-1', roleName: 'dev' });
      session.close();
      expect(session.status).toBe('closed');
    });

    it('active → expired → closed', () => {
      const session = Session.create({ projectId: 'p-1', roleName: 'dev' });
      session.expire();
      expect(session.status).toBe('expired');
      session.close();
      expect(session.status).toBe('closed');
    });

    it('rejects closed → active', () => {
      const session = Session.create({ projectId: 'p-1', roleName: 'dev' });
      session.close();
      expect(() => session.transitionTo('active')).toThrow(InvalidTransitionError);
    });
  });

  describe('serialization', () => {
    it('roundtrips through toRow/fromRow', () => {
      const session = Session.create({ projectId: 'p-1', roleName: 'analyst', cliSessionId: 'cli-99' });
      const row = session.toRow();
      const restored = Session.fromRow(row);
      expect(restored.id).toBe(session.id);
      expect(restored.cliSessionId).toBe('cli-99');
      expect(restored.roleName).toBe('analyst');
    });
  });
});
