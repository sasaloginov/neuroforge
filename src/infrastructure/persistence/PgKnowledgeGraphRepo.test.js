import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgKnowledgeGraphRepo } from './PgKnowledgeGraphRepo.js';
import { KGEntity } from '../../domain/valueObjects/KGEntity.js';
import { KGRelation } from '../../domain/valueObjects/KGRelation.js';
import { createPool, closePool, getPool } from './pg.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PgKnowledgeGraphRepo (integration)', () => {
  let repo;
  let projectId;

  beforeAll(async () => {
    createPool(DATABASE_URL);
    repo = new PgKnowledgeGraphRepo();

    projectId = crypto.randomUUID();

    // Create a test project
    await getPool().query(
      `INSERT INTO projects (id, name, prefix, repo_url) VALUES ($1, $2, $3, $4)`,
      [projectId, `test-kg-${projectId.slice(0, 8)}`, 'TSTKG', 'https://github.com/test/kg'],
    );
  });

  afterAll(async () => {
    // Cleanup in correct order (relations before entities)
    await getPool().query('DELETE FROM kg_relations WHERE project_id = $1', [projectId]);
    await getPool().query('DELETE FROM kg_entities WHERE project_id = $1', [projectId]);
    await getPool().query('DELETE FROM projects WHERE id = $1', [projectId]);
    await closePool();
  });

  describe('upsertEntity', () => {
    it('inserts a new entity', async () => {
      const entity = KGEntity.create({
        projectId,
        entityType: 'module',
        name: 'TaskService',
      });

      const saved = await repo.upsertEntity(entity);
      expect(saved.id).toBeDefined();
      expect(saved.name).toBe('TaskService');
      expect(saved.normalizedName).toBe('taskservice');
      expect(saved.entityType).toBe('module');
    });

    it('deduplicates on conflict — merges properties', async () => {
      const entity1 = KGEntity.create({
        projectId,
        entityType: 'technology',
        name: 'PostgreSQL',
        properties: { version: '16' },
      });
      const saved1 = await repo.upsertEntity(entity1);

      const entity2 = KGEntity.create({
        projectId,
        entityType: 'technology',
        name: 'PostgreSQL',
        properties: { extensions: ['pgvector'] },
      });
      const saved2 = await repo.upsertEntity(entity2);

      // Same entity returned (by normalized_name+type+project dedup)
      expect(saved2.id).toBe(saved1.id);
      // Properties should be merged
      expect(saved2.properties).toHaveProperty('version');
      expect(saved2.properties).toHaveProperty('extensions');
    });
  });

  describe('upsertRelation', () => {
    let entityA;
    let entityB;

    beforeAll(async () => {
      entityA = await repo.upsertEntity(KGEntity.create({
        projectId,
        entityType: 'module',
        name: 'RelTestModuleA',
      }));
      entityB = await repo.upsertEntity(KGEntity.create({
        projectId,
        entityType: 'module',
        name: 'RelTestModuleB',
      }));
    });

    it('inserts a new relation', async () => {
      const relation = KGRelation.create({
        projectId,
        sourceEntityId: entityA.id,
        targetEntityId: entityB.id,
        relationType: 'DEPENDS_ON',
        confidence: 0.8,
      });

      const saved = await repo.upsertRelation(relation);
      expect(saved.id).toBeDefined();
      expect(saved.relationType).toBe('DEPENDS_ON');
      expect(saved.confidence).toBe(0.8);
    });

    it('deduplicates — keeps GREATEST confidence', async () => {
      const rel1 = KGRelation.create({
        projectId,
        sourceEntityId: entityA.id,
        targetEntityId: entityB.id,
        relationType: 'USES',
        confidence: 0.6,
      });
      const saved1 = await repo.upsertRelation(rel1);

      const rel2 = KGRelation.create({
        projectId,
        sourceEntityId: entityA.id,
        targetEntityId: entityB.id,
        relationType: 'USES',
        confidence: 0.95,
      });
      const saved2 = await repo.upsertRelation(rel2);

      expect(saved2.id).toBe(saved1.id);
      expect(saved2.confidence).toBe(0.95);
    });
  });

  describe('findEntitiesByText', () => {
    beforeAll(async () => {
      await repo.upsertEntity(KGEntity.create({
        projectId,
        entityType: 'module',
        name: 'AgentMemoryService',
      }));
      await repo.upsertEntity(KGEntity.create({
        projectId,
        entityType: 'concept',
        name: 'Domain Driven Design',
      }));
    });

    it('finds entities by FTS match', async () => {
      const results = await repo.findEntitiesByText(projectId, 'AgentMemoryService');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(e => e.name === 'AgentMemoryService')).toBe(true);
    });

    it('finds entities by partial ILIKE match', async () => {
      const results = await repo.findEntitiesByText(projectId, 'Memory');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(e => e.name.includes('Memory'))).toBe(true);
    });

    it('returns empty for no matches', async () => {
      const results = await repo.findEntitiesByText(projectId, 'NonExistentXYZ12345');
      expect(results).toHaveLength(0);
    });
  });

  describe('traverse', () => {
    let eA, eB, eC;

    beforeAll(async () => {
      // Create chain: A → B → C (and C → A for cycle test)
      eA = await repo.upsertEntity(KGEntity.create({
        projectId, entityType: 'module', name: 'TraverseNodeA',
      }));
      eB = await repo.upsertEntity(KGEntity.create({
        projectId, entityType: 'module', name: 'TraverseNodeB',
      }));
      eC = await repo.upsertEntity(KGEntity.create({
        projectId, entityType: 'module', name: 'TraverseNodeC',
      }));

      await repo.upsertRelation(KGRelation.create({
        projectId,
        sourceEntityId: eA.id,
        targetEntityId: eB.id,
        relationType: 'DEPENDS_ON',
        confidence: 0.9,
      }));
      await repo.upsertRelation(KGRelation.create({
        projectId,
        sourceEntityId: eB.id,
        targetEntityId: eC.id,
        relationType: 'DEPENDS_ON',
        confidence: 0.8,
      }));
      // Create cycle: C → A
      await repo.upsertRelation(KGRelation.create({
        projectId,
        sourceEntityId: eC.id,
        targetEntityId: eA.id,
        relationType: 'DEPENDS_ON',
        confidence: 0.7,
      }));
    });

    it('returns 1-hop neighbors', async () => {
      const { entities } = await repo.traverse(projectId, [eA.id], 1);
      const names = entities.map(e => e.name);
      expect(names).toContain('TraverseNodeA');
      expect(names).toContain('TraverseNodeB');
    });

    it('returns 2-hop neighbors', async () => {
      const { entities } = await repo.traverse(projectId, [eA.id], 2);
      const names = entities.map(e => e.name);
      expect(names).toContain('TraverseNodeA');
      expect(names).toContain('TraverseNodeB');
      expect(names).toContain('TraverseNodeC');
    });

    it('handles cycles without infinite loop (A→B→C→A)', async () => {
      // depth=10 should still terminate due to cycle prevention
      const { entities } = await repo.traverse(projectId, [eA.id], 10);
      // Should find all 3 nodes without hanging
      expect(entities.length).toBeGreaterThanOrEqual(3);
      // No duplicates
      const ids = entities.map(e => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('returns empty for non-existent entity IDs', async () => {
      const { entities, relations, memoryIds } = await repo.traverse(
        projectId, [crypto.randomUUID()], 2
      );
      expect(entities).toHaveLength(0);
      expect(relations).toHaveLength(0);
      expect(memoryIds).toHaveLength(0);
    });
  });

  describe('getEntityRelations', () => {
    it('returns relations for an entity', async () => {
      // Use entities created in traverse tests
      const entities = await repo.findEntitiesByText(projectId, 'TraverseNodeA');
      if (entities.length === 0) return; // skip if traverse setup didn't run

      const relations = await repo.getEntityRelations(entities[0].id);
      expect(relations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getProjectGraph', () => {
    it('returns entities and relations for project', async () => {
      const { entities, relations } = await repo.getProjectGraph(projectId);
      expect(entities.length).toBeGreaterThanOrEqual(1);
      // Relations should exist between project entities
      expect(relations.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by entity types', async () => {
      const { entities } = await repo.getProjectGraph(projectId, {
        entityTypes: ['concept'],
      });
      for (const e of entities) {
        expect(e.entityType).toBe('concept');
      }
    });
  });
});
