// Usage: DATABASE_URL=... node scripts/make-admin.mjs someone@example.com
import { query, closePool } from '../src/server/db.mjs';
const email = (process.argv[2] || '').toLowerCase();
if (!email) { console.error('usage: make-admin <email>'); process.exit(1); }
const r = await query("UPDATE users SET role = 'admin' WHERE lower(email) = $1 RETURNING id", [email]);
console.log(r.rowCount ? `Promoted ${email} to admin` : `No user with email ${email}`);
await closePool();
