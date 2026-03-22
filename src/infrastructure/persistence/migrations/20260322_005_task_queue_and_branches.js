/**
 * Migration 005: Task queue and git branches
 * - Add branch_name column to tasks
 * - Update status constraint to include 'backlog'
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE tasks ADD COLUMN branch_name VARCHAR(255);
  `);

  // Drop old constraint and recreate with backlog
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
  `);
  await knex.raw(`
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('pending', 'in_progress', 'waiting_reply', 'needs_escalation', 'backlog', 'done', 'failed', 'cancelled'));
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
  `);
  await knex.raw(`
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('pending', 'in_progress', 'waiting_reply', 'needs_escalation', 'done', 'failed', 'cancelled'));
  `);
  await knex.raw(`
    ALTER TABLE tasks DROP COLUMN IF EXISTS branch_name;
  `);
}
