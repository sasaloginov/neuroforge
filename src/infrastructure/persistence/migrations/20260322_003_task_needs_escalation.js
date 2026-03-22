export function up(knex) {
  return knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('pending', 'in_progress', 'waiting_reply', 'needs_escalation', 'done', 'failed', 'cancelled'));
  `);
}

export function down(knex) {
  return knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('pending', 'in_progress', 'waiting_reply', 'done', 'failed', 'cancelled'));
  `);
}
