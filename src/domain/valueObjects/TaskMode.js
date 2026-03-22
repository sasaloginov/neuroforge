const MODES = {
  FULL: 'full',
  RESEARCH: 'research',
};

function isValidMode(mode) {
  return Object.values(MODES).includes(mode);
}

export { MODES as TaskMode, isValidMode };
