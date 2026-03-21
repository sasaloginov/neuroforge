export class Project {
  constructor({ id, name, repoUrl, workDir, createdAt }) {
    this.id = id;
    this.name = name;
    this.repoUrl = repoUrl;
    this.workDir = workDir ?? null;
    this.createdAt = createdAt;
  }

  static create({ name, repoUrl, workDir }) {
    return new Project({
      id: crypto.randomUUID(),
      name,
      repoUrl,
      workDir,
      createdAt: new Date(),
    });
  }

  static fromRow(row) {
    return new Project({
      id: row.id,
      name: row.name,
      repoUrl: row.repo_url,
      workDir: row.work_dir,
      createdAt: row.created_at,
    });
  }

  toRow() {
    return {
      id: this.id,
      name: this.name,
      repo_url: this.repoUrl,
      work_dir: this.workDir,
      created_at: this.createdAt,
    };
  }
}
