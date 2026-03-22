export function up(knex) {
  return knex.schema.raw(`
    CREATE UNIQUE INDEX idx_sessions_project_role_active
    ON sessions (project_id, role_name)
    WHERE status = 'active'
  `);
}

export function down(knex) {
  return knex.schema.raw('DROP INDEX IF EXISTS idx_sessions_project_role_active');
}
