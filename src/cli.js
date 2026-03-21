import { parseArgs } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { User } from './domain/entities/User.js';
import { ApiKey } from './domain/entities/ApiKey.js';
import { PgUserRepo } from './infrastructure/persistence/PgUserRepo.js';
import { PgApiKeyRepo } from './infrastructure/persistence/PgApiKeyRepo.js';
import { createPool, closePool } from './infrastructure/persistence/pg.js';

async function createAdmin() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
    },
    strict: false,
  });

  if (!values.name) {
    console.error('Usage: node src/cli.js create-admin --name "Name"');
    process.exit(1);
  }

  createPool(process.env.DATABASE_URL);
  const userRepo = new PgUserRepo();
  const apiKeyRepo = new PgApiKeyRepo();

  const user = User.create({ name: values.name, role: 'admin' });
  await userRepo.save(user);

  const rawToken = 'nf_' + randomBytes(32).toString('hex');
  const keyHash = createHash('sha256').update(rawToken).digest('hex');
  const apiKey = ApiKey.create({
    name: `${values.name}-bootstrap`,
    keyHash,
    userId: user.id,
  });
  await apiKeyRepo.save(apiKey);

  console.log(`Admin created: ${user.name} (${user.id})`);
  console.log(`API Token (save it, shown only once): ${rawToken}`);

  await closePool();
}

const command = process.argv[2];
if (command === 'create-admin') {
  createAdmin().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Available: create-admin');
  process.exit(1);
}
