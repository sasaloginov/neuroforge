export async function up(knex) {
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('backlog', 'pending', 'in_progress', 'waiting_reply',
                        'needs_escalation', 'research_done', 'done', 'failed', 'cancelled'));
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('backlog', 'pending', 'in_progress', 'waiting_reply',
                        'needs_escalation', 'done', 'failed', 'cancelled'));
  `);
}
