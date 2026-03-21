/**
 * Worker factory — creates an object that processes one run from the queue.
 *
 * @param {object} deps
 * @param {import('../../application/ProcessRun.js').ProcessRun} deps.processRun
 * @param {import('../../application/ManagerDecision.js').ManagerDecision} deps.managerDecision
 * @param {object} deps.logger
 * @returns {{ processOne: () => Promise<boolean> }}
 */
export function createWorker({ processRun, managerDecision, logger }) {
  return {
    async processOne() {
      let result;
      try {
        result = await processRun.execute();
      } catch (err) {
        logger.error('[Worker] ProcessRun threw: %s', err.message);
        return false;
      }

      if (!result) return false; // queue empty

      const { run } = result;

      if (run.taskId) {
        try {
          await managerDecision.execute({ completedRunId: run.id });
        } catch (err) {
          logger.error('[Worker] ManagerDecision failed for run %s: %s', run.id, err.message);
          // Don't re-throw — worker continues
        }
      }

      return true; // processed one
    },
  };
}
