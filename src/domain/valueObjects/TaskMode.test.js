import { describe, it, expect } from 'vitest';
import { TaskMode, isValidMode } from './TaskMode.js';

describe('TaskMode', () => {
  it('defines FULL and RESEARCH modes', () => {
    expect(TaskMode.FULL).toBe('full');
    expect(TaskMode.RESEARCH).toBe('research');
  });

  it('isValidMode returns true for valid modes', () => {
    expect(isValidMode('full')).toBe(true);
    expect(isValidMode('research')).toBe(true);
  });

  it('isValidMode returns false for invalid modes', () => {
    expect(isValidMode('unknown')).toBe(false);
    expect(isValidMode('')).toBe(false);
    expect(isValidMode(null)).toBe(false);
    expect(isValidMode(undefined)).toBe(false);
  });
});
