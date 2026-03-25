/**
 * Migration: Knowledge Graph tables (kg_entities + kg_relations).
 * Provides graph-based retrieval on top of agent_memories.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE kg_entities (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      entity_type     VARCHAR(30) NOT NULL CHECK (entity_type IN (
        'module', 'concept', 'decision', 'technology', 'pattern', 'problem', 'person'
      )),
      name            TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      properties      JSONB NOT NULL DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, entity_type, normalized_name)
    )
  `);

  await knex.raw(`CREATE INDEX idx_kg_entities_project ON kg_entities(project_id)`);
  await knex.raw(`CREATE INDEX idx_kg_entities_name ON kg_entities USING gin(to_tsvector('simple', name))`);

  await knex.raw(`
    CREATE TABLE kg_relations (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_entity_id  UUID NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
      target_entity_id  UUID NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
      relation_type     VARCHAR(30) NOT NULL CHECK (relation_type IN (
        'USES', 'DEPENDS_ON', 'IMPLEMENTS', 'DECIDED', 'CAUSED_BY', 'RESOLVED_BY', 'RELATES_TO'
      )),
      confidence        REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
      memory_id         UUID REFERENCES agent_memories(id) ON DELETE SET NULL,
      properties        JSONB NOT NULL DEFAULT '{}',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_entity_id, target_entity_id, relation_type)
    )
  `);

  await knex.raw(`CREATE INDEX idx_kg_relations_source ON kg_relations(source_entity_id)`);
  await knex.raw(`CREATE INDEX idx_kg_relations_target ON kg_relations(target_entity_id)`);
  await knex.raw(`CREATE INDEX idx_kg_relations_memory ON kg_relations(memory_id)`);
  await knex.raw(`CREATE INDEX idx_kg_relations_project ON kg_relations(project_id)`);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS kg_relations CASCADE');
  await knex.raw('DROP TABLE IF EXISTS kg_entities CASCADE');
}
