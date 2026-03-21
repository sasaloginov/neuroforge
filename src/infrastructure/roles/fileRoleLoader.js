import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { Role } from '../../domain/valueObjects/Role.js';

/**
 * Load all role definitions from `roles/*.md` files.
 *
 * Each file must have YAML frontmatter delimited by `---`:
 *   ---
 *   name: analyst
 *   model: opus
 *   timeout_ms: 300000
 *   allowed_tools: [Read, Glob]
 *   ---
 *   <body = systemPrompt>
 *
 * @param {string} rolesDir — absolute path to roles/ directory
 * @returns {Promise<Role[]>}
 */
export async function loadRoles(rolesDir) {
  const files = await readdir(rolesDir);
  const mdFiles = files.filter((f) => f.endsWith('.md')).sort();

  const roles = [];

  for (const file of mdFiles) {
    const content = await readFile(join(rolesDir, file), 'utf-8');
    const role = parseRoleFile(content, file);
    roles.push(role);
  }

  return roles;
}

/**
 * Parse a single role markdown file.
 * @param {string} content — raw file content
 * @param {string} filename — for error messages
 * @returns {Role}
 */
export function parseRoleFile(content, filename) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`Invalid frontmatter in ${filename}: missing --- delimiters`);
  }

  const [, frontmatterStr, body] = match;

  let frontmatter;
  try {
    frontmatter = YAML.parse(frontmatterStr);
  } catch (err) {
    throw new Error(`Invalid YAML frontmatter in ${filename}: ${err.message}`);
  }

  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new Error(`Invalid frontmatter in ${filename}: expected an object`);
  }

  const { name, model, timeout_ms, allowed_tools } = frontmatter;

  if (!name) throw new Error(`Missing 'name' in frontmatter of ${filename}`);
  if (!model) throw new Error(`Missing 'model' in frontmatter of ${filename}`);
  if (!timeout_ms) throw new Error(`Missing 'timeout_ms' in frontmatter of ${filename}`);

  return new Role({
    name,
    model,
    timeoutMs: timeout_ms,
    allowedTools: allowed_tools ?? [],
    systemPrompt: body.trim(),
  });
}
