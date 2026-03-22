import { ValidationError } from '../errors/ValidationError.js';

const PREFIX_RE = /^[A-Z][A-Z0-9]{0,9}$/;

export class Project {
  constructor({ id, name, prefix, repoUrl, workDir, createdAt }) {
    this.id = id;
    this.name = name;
    this.prefix = prefix;
    this.repoUrl = repoUrl;
    this.workDir = workDir ?? null;
    this.createdAt = createdAt;
  }

  static create({ name, prefix, repoUrl, workDir }) {
    const normalized = prefix ? prefix.toUpperCase() : undefined;
    if (!normalized || !PREFIX_RE.test(normalized)) {
      throw new ValidationError(
        'prefix must be 1-10 uppercase letters/digits, starting with a letter',
      );
    }
    return new Project({
      id: crypto.randomUUID(),
      name,
      prefix: normalized,
      repoUrl,
      workDir,
      createdAt: new Date(),
    });
  }

  static fromRow(row) {
    return new Project({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      repoUrl: row.repo_url,
      workDir: row.work_dir,
      createdAt: row.created_at,
    });
  }

  toRow() {
    return {
      id: this.id,
      name: this.name,
      prefix: this.prefix,
      repo_url: this.repoUrl,
      work_dir: this.workDir,
      created_at: this.createdAt,
    };
  }
}
