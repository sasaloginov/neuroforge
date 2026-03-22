import { describe, it, expect } from 'vitest';
import { createButton, BUTTON_COLOR, BUTTON_LABEL } from './blueButton.js';

describe('NF-14: Blue Button (ask_owner demo)', () => {
  it('uses blue color as chosen by the owner', () => {
    const button = createButton();
    expect(button.style.backgroundColor).toBe('#2563EB');
  });

  it('has correct default label', () => {
    const button = createButton();
    expect(button.label).toBe('Отправить');
  });

  it('allows custom label while keeping blue color', () => {
    const button = createButton({ label: 'Далее' });
    expect(button.label).toBe('Далее');
    expect(button.style.backgroundColor).toBe(BUTTON_COLOR);
  });

  it('exports blue as the chosen color constant', () => {
    expect(BUTTON_COLOR).toBe('#2563EB');
  });
});
