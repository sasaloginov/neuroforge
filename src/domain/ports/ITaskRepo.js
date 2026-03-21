/**
 * Port for Task persistence.
 *
 * @interface ITaskRepo
 * @method findById(id) → Task | null
 * @method findByProjectId(projectId, filters?) → Task[]
 * @method save(task) → void
 * @method delete(id) → void
 */
export class ITaskRepo {
  async findById(_id) { throw new Error('Not implemented'); }
  async findByProjectId(_projectId, _filters) { throw new Error('Not implemented'); }
  async save(_task) { throw new Error('Not implemented'); }
  async delete(_id) { throw new Error('Not implemented'); }
}
