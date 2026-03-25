/**
 * Migration: add 'fix' to task mode check constraint.
 * Fix mode skips analyst and goes straight to developer.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_mode_check
  `);
  await knex.raw(`
    ALTER TABLE tasks ADD CONSTRAINT tasks_mode_check
    CHECK (mode IN ('full', 'research', 'fix', 'auto'))
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_mode_check
  `);
  await knex.raw(`
    ALTER TABLE tasks ADD CONSTRAINT tasks_mode_check
    CHECK (mode IN ('full', 'research', 'auto'))
  `);
}
