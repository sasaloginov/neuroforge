/**
 * PostgreSQL connection pool (singleton).
 * Provides createPool, getPool, closePool.
 */

import pg from 'pg';

const { Pool } = pg;

let pool = null;

/**
 * Create and return a PostgreSQL connection pool.
 * @param {string} connectionString - DATABASE_URL
 * @returns {import('pg').Pool}
 */
export function createPool(connectionString) {
  if (pool) return pool;

  pool = new Pool({ connectionString });

  pool.on('error', (err) => {
    console.error('[pg] Unexpected pool error:', err.message);
  });

  return pool;
}

/**
 * Get the existing pool instance.
 * @returns {import('pg').Pool}
 * @throws {Error} if pool not created
 */
export function getPool() {
  if (!pool) {
    throw new Error('[pg] Pool not initialized. Call createPool() first.');
  }
  return pool;
}

/**
 * Gracefully close the pool.
 */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
