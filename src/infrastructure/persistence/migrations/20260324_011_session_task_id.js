/**
 * Migration: Add task_id to sessions for task-scoped sessions.
 * Pipeline v2 uses sessions per (task_id, role_name) instead of (project_id, role_name).
 */
export async function up(knex) {
  await knex.schema.alterTable('sessions', (table) => {
    table.uuid('task_id').references('id').inTable('tasks').onDelete('CASCADE');
  });

  // Create unique index for task-scoped sessions (task_id + role_name, only active)
  await knex.raw(`
    CREATE UNIQUE INDEX idx_sessions_task_role_active
    ON sessions (task_id, role_name)
    WHERE task_id IS NOT NULL AND status = 'active'
  `);
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_sessions_task_role_active');
  await knex.schema.alterTable('sessions', (table) => {
    table.dropColumn('task_id');
  });
}
