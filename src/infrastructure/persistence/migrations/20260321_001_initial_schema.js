export function up(knex) {
  return knex.schema
    .createTable('users', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('name', 128).notNullable();
      t.string('role', 32).notNullable().defaultTo('member');
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    })

    .createTable('projects', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('name', 128).unique().notNullable();
      t.string('repo_url', 512).notNullable();
      t.string('work_dir', 512);
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    })

    .createTable('api_keys', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('name', 128).notNullable();
      t.string('key_hash', 256).unique().notNullable();
      t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.uuid('project_id').references('id').inTable('projects');
      t.timestamp('expires_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

      t.index('key_hash', 'idx_api_keys_key_hash');
      t.index('user_id', 'idx_api_keys_user_id');
    })

    .createTable('sessions', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('project_id').notNullable().references('id').inTable('projects').onDelete('CASCADE');
      t.string('cli_session_id', 255);
      t.string('role_name', 64).notNullable();
      t.string('status', 32).defaultTo('active');
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

      t.index('project_id', 'idx_sessions_project_id');
    })

    .createTable('tasks', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('project_id').notNullable().references('id').inTable('projects').onDelete('CASCADE');
      t.string('title', 255).notNullable();
      t.text('description');
      t.string('status', 32).defaultTo('pending');
      t.string('callback_url', 512);
      t.jsonb('callback_meta');
      t.integer('revision_count').defaultTo(0);
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

      t.index('project_id', 'idx_tasks_project_id');
      t.index('status', 'idx_tasks_status');
    })

    .createTable('task_steps', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('task_id').notNullable().references('id').inTable('tasks').onDelete('CASCADE');
      t.string('role_name', 64).notNullable();
      t.uuid('session_id').references('id').inTable('sessions');
      t.integer('step_order').notNullable();
      t.text('prompt_template').notNullable();
      t.string('status', 32).defaultTo('pending');
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

      t.index('task_id', 'idx_task_steps_task_id');
    })

    .createTable('runs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('session_id').references('id').inTable('sessions');
      t.uuid('task_id').references('id').inTable('tasks');
      t.uuid('step_id').references('id').inTable('task_steps');
      t.string('role_name', 64).notNullable();
      t.text('prompt').notNullable();
      t.text('response');
      t.string('status', 32).defaultTo('queued');
      t.string('callback_url', 512);
      t.jsonb('callback_meta');
      t.timestamp('started_at', { useTz: true });
      t.timestamp('finished_at', { useTz: true });
      t.integer('duration_ms');
      t.text('error');
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

      t.index('status', 'idx_runs_status');
      t.index('task_id', 'idx_runs_task_id');
    })

    .createTable('message_log', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('session_id').references('id').inTable('sessions');
      t.string('direction', 8).notNullable();
      t.text('content').notNullable();
      t.integer('tokens_in');
      t.integer('tokens_out');
      t.integer('duration_ms');
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

      t.index('session_id', 'idx_message_log_session_id');
    });
}

export function down(knex) {
  return knex.schema
    .dropTableIfExists('message_log')
    .dropTableIfExists('runs')
    .dropTableIfExists('task_steps')
    .dropTableIfExists('tasks')
    .dropTableIfExists('sessions')
    .dropTableIfExists('api_keys')
    .dropTableIfExists('projects')
    .dropTableIfExists('users');
}
