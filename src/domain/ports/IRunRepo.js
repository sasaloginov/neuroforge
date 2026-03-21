/**
 * Port for Run persistence + queue operations.
 *
 * @interface IRunRepo
 * @method findById(id) → Run | null
 * @method findByTaskId(taskId) → Run[]
 * @method findRunning() → Run[] — all runs with status 'running'
 * @method save(run) → void
 * @method takeNext() → Run | null — dequeue next (FOR UPDATE SKIP LOCKED)
 */
export class IRunRepo {
  async findById(_id) { throw new Error('Not implemented'); }
  async findByTaskId(_taskId) { throw new Error('Not implemented'); }
  async findRunning() { throw new Error('Not implemented'); }
  async save(_run) { throw new Error('Not implemented'); }
  async takeNext() { throw new Error('Not implemented'); }
}
