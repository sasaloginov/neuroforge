export class User {
  constructor({ id, name, role, createdAt }) {
    this.id = id;
    this.name = name;
    this.role = role;
    this.createdAt = createdAt;
  }

  static create({ name, role = 'member' }) {
    return new User({
      id: crypto.randomUUID(),
      name,
      role,
      createdAt: new Date(),
    });
  }

  static fromRow(row) {
    return new User({
      id: row.id,
      name: row.name,
      role: row.role,
      createdAt: row.created_at,
    });
  }

  toRow() {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      created_at: this.createdAt,
    };
  }
}
