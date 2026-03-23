export async function up(knex) {
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_mode_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_mode_check
      CHECK (mode IN ('full', 'research', 'auto'));
  `);
  await knex.raw(`ALTER TABLE tasks ALTER COLUMN mode SET DEFAULT 'auto'`);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_mode_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_mode_check
      CHECK (mode IN ('full', 'research'));
  `);
  await knex.raw(`ALTER TABLE tasks ALTER COLUMN mode SET DEFAULT 'full'`);
}
