export async function up(knex) {
  // 1. Добавить prefix в projects
  await knex.schema.alterTable('projects', (t) => {
    t.string('prefix', 10);
  });

  // 2. Заполнить prefix для существующих проектов
  await knex.raw(`UPDATE projects SET prefix = 'NF' WHERE name = 'neuroforge'`);
  await knex.raw(`UPDATE projects SET prefix = 'BOT' WHERE name = 'mybot'`);
  await knex.raw(`UPDATE projects SET prefix = UPPER(LEFT(name, 3)) WHERE prefix IS NULL`);

  // 3. NOT NULL + UNIQUE
  await knex.schema.alterTable('projects', (t) => {
    t.string('prefix', 10).notNullable().alter();
    t.unique('prefix', 'uq_projects_prefix');
  });

  // 4. Добавить seq_number в tasks
  await knex.schema.alterTable('tasks', (t) => {
    t.integer('seq_number');
  });

  // 5. Заполнить seq_number для существующих задач
  await knex.raw(`
    WITH numbered AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at) AS rn
      FROM tasks
    )
    UPDATE tasks SET seq_number = numbered.rn
    FROM numbered WHERE tasks.id = numbered.id
  `);

  // 6. NOT NULL + unique per project
  await knex.schema.alterTable('tasks', (t) => {
    t.integer('seq_number').notNullable().alter();
    t.unique(['project_id', 'seq_number'], 'uq_tasks_project_seq');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('tasks', (t) => {
    t.dropUnique(['project_id', 'seq_number'], 'uq_tasks_project_seq');
    t.dropColumn('seq_number');
  });
  await knex.schema.alterTable('projects', (t) => {
    t.dropUnique('prefix', 'uq_projects_prefix');
    t.dropColumn('prefix');
  });
}
