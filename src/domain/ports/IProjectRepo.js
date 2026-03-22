/**
 * Port for Project persistence.
 *
 * @interface IProjectRepo
 * @method findById(id) → Project | null
 * @method findByName(name) → Project | null
 * @method findByPrefix(prefix) → Project | null
 * @method save(project) → void
 * @method findAll() → Project[]
 */
export class IProjectRepo {
  async findById(_id) { throw new Error('Not implemented'); }
  async findByName(_name) { throw new Error('Not implemented'); }
  async findByPrefix(_prefix) { throw new Error('Not implemented'); }
  async save(_project) { throw new Error('Not implemented'); }
  async findAll() { throw new Error('Not implemented'); }
}
