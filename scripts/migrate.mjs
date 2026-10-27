import { ensureMigrated, closePool } from '../src/server/db.mjs';
await ensureMigrated();
console.log('Migrations up to date');
await closePool();
