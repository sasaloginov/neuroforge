export async function up(knex) {
  await knex.schema.alterTable('runs', (t) => {
    t.jsonb('usage').nullable().defaultTo(null);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('runs', (t) => {
    t.dropColumn('usage');
  });
}
