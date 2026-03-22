/**
 * Demo component: Blue Button
 *
 * This file was created as part of task NF-14 to validate the ask_owner flow.
 * The analyst asked the owner: "Какой цвет предпочесть для кнопки — синий или зелёный?"
 * The owner replied: "Синий"
 *
 * This minimal artifact confirms the owner's answer was propagated
 * through the pipeline and used in the development step.
 */

export const BUTTON_COLOR = '#2563EB'; // blue-600
export const BUTTON_LABEL = 'Отправить';

export function createButton({ label = BUTTON_LABEL, color = BUTTON_COLOR } = {}) {
  return {
    type: 'button',
    label,
    style: {
      backgroundColor: color,
      color: '#FFFFFF',
      borderRadius: '8px',
      padding: '10px 24px',
      border: 'none',
      cursor: 'pointer',
    },
  };
}
