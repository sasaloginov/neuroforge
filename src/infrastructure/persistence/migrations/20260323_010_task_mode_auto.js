export async function up(knex) {
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_mode_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_mode_check
      CHECK (mode IN ('full', 'research', 'auto'));
  `);
  await knex.raw(`ALTER TABLE tasks ALTER COLUMN mode SET DEFAULT 'auto'`);
}

export async function down(knex) {
  // Convert existing 'auto' rows to 'full' before restoring the old constraint
  await knex.raw(`UPDATE tasks SET mode = 'full' WHERE mode = 'auto'`);
  await knex.raw(`ALTER TABLE tasks ALTER COLUMN mode SET DEFAULT 'full'`);
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_mode_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_mode_check
      CHECK (mode IN ('full', 'research'));
  `);
}
