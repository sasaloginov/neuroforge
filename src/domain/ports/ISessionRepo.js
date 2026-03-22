/**
 * Port for Session persistence.
 *
 * @interface ISessionRepo
 * @method findById(id) → Session | null
 * @method findByProjectAndRole(projectId, roleName) → Session | null
 * @method findOrCreate(projectId, roleName) → Session
 * @method save(session) → void
 * @method delete(id) → void
 */
export class ISessionRepo {
  async findById(_id) { throw new Error('Not implemented'); }
  async findByProjectAndRole(_projectId, _roleName) { throw new Error('Not implemented'); }
  async findOrCreate(_projectId, _roleName) { throw new Error('Not implemented'); }
  async save(_session) { throw new Error('Not implemented'); }
  async delete(_id) { throw new Error('Not implemented'); }
}
