const MODES = {
  FULL: 'full',
  RESEARCH: 'research',
  AUTO: 'auto',
};

function isValidMode(mode) {
  return Object.values(MODES).includes(mode);
}

export { MODES as TaskMode, isValidMode };
