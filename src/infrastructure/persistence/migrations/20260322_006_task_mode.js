export async function up(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.string('mode', 32).defaultTo('full').notNullable();
  });
  await knex.raw(`
    ALTER TABLE tasks ADD CONSTRAINT tasks_mode_check
      CHECK (mode IN ('full', 'research'));
  `);
}

export async function down(knex) {
  await knex.raw('ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_mode_check');
  await knex.schema.alterTable('tasks', (table) => {
    table.dropColumn('mode');
  });
}
