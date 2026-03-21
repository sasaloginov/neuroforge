export class ApiKey {
  constructor({ id, name, keyHash, userId, projectId, expiresAt, createdAt }) {
    this.id = id;
    this.name = name;
    this.keyHash = keyHash;
    this.userId = userId;
    this.projectId = projectId ?? null;
    this.expiresAt = expiresAt ?? null;
    this.createdAt = createdAt;
  }

  static create({ name, keyHash, userId, projectId, expiresAt }) {
    return new ApiKey({
      id: crypto.randomUUID(),
      name,
      keyHash,
      userId,
      projectId,
      expiresAt,
      createdAt: new Date(),
    });
  }

  isExpired() {
    return this.expiresAt ? new Date() > this.expiresAt : false;
  }

  static fromRow(row) {
    return new ApiKey({
      id: row.id,
      name: row.name,
      keyHash: row.key_hash,
      userId: row.user_id,
      projectId: row.project_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    });
  }

  toRow() {
    return {
      id: this.id,
      name: this.name,
      key_hash: this.keyHash,
      user_id: this.userId,
      project_id: this.projectId,
      expires_at: this.expiresAt,
      created_at: this.createdAt,
    };
  }
}
