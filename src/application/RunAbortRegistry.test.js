import { RunAbortRegistry } from './RunAbortRegistry.js';

describe('RunAbortRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new RunAbortRegistry();
  });

  it('register + abort calls controller.abort() and returns true', () => {
    const controller = new AbortController();
    registry.register('run-1', controller);

    expect(registry.abort('run-1')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('abort unregistered runId returns false', () => {
    expect(registry.abort('unknown')).toBe(false);
  });

  it('unregister removes controller — abort returns false after', () => {
    const controller = new AbortController();
    registry.register('run-1', controller);
    registry.unregister('run-1');

    expect(registry.abort('run-1')).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it('re-register overwrites previous controller', () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    registry.register('run-1', controller1);
    registry.register('run-1', controller2);

    registry.abort('run-1');
    expect(controller1.signal.aborted).toBe(false);
    expect(controller2.signal.aborted).toBe(true);
  });

  it('has() returns true for registered, false for unregistered', () => {
    const controller = new AbortController();
    registry.register('run-1', controller);

    expect(registry.has('run-1')).toBe(true);
    expect(registry.has('run-2')).toBe(false);
  });

  it('abort removes from registry — has() returns false after', () => {
    const controller = new AbortController();
    registry.register('run-1', controller);
    registry.abort('run-1');

    expect(registry.has('run-1')).toBe(false);
  });
});
