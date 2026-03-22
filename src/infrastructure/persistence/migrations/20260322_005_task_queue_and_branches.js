export async function up(knex) {
  await knex.schema.alterTable('tasks', table => {
    table.string('branch_name', 255).nullable();
  });
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('backlog', 'pending', 'in_progress', 'waiting_reply',
                        'needs_escalation', 'done', 'failed', 'cancelled'));
  `);
  await knex.raw(`
    CREATE INDEX idx_tasks_project_status ON tasks (project_id, status, created_at)
    WHERE status IN ('pending', 'in_progress', 'waiting_reply', 'needs_escalation');
  `);
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_tasks_project_status');
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('pending', 'in_progress', 'waiting_reply',
                        'needs_escalation', 'done', 'failed', 'cancelled'));
  `);
  await knex.schema.alterTable('tasks', table => {
    table.dropColumn('branch_name');
  });
}
