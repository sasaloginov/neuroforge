/**
 * Port for Task persistence.
 *
 * @interface ITaskRepo
 * @method findById(id) → Task | null
 * @method findByProjectId(projectId, filters?) → Task[]
 * @method findByProjectIdAndSeq(projectId, seqNumber) → Task | null
 * @method save(task) → void
 * @method saveWithSeqNumber(task) → Task  — atomically assigns next seq_number and inserts (mutates task.seqNumber)
 * @method delete(id) → void
 */
export class ITaskRepo {
  async findById(_id) { throw new Error('Not implemented'); }
  async findByProjectId(_projectId, _filters) { throw new Error('Not implemented'); }
  async findByProjectIdAndSeq(_projectId, _seqNumber) { throw new Error('Not implemented'); }
  async save(_task) { throw new Error('Not implemented'); }
  async saveWithSeqNumber(_task) { throw new Error('Not implemented'); }
  async delete(_id) { throw new Error('Not implemented'); }
  async hasActiveTask(_projectId) { throw new Error('Not implemented'); }
  async findOldestPending(_projectId) { throw new Error('Not implemented'); }
  async activateOldestPending(_projectId) { throw new Error('Not implemented'); }
  async activateIfNoActive(_taskId, _projectId) { throw new Error('Not implemented'); }
}
