import 'dotenv/config';

export default {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 1, max: 5 },
  migrations: {
    directory: './migrations',
  },
};
