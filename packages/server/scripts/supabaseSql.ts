// Run SQL against a Supabase project via the Management API.
// Secrets come from env — never hard-code them here.
//   SUPABASE_ACCESS_TOKEN=sbp_... PROJECT_REF=<ref> SQL="select 1"   tsx supabaseSql.ts
//   SUPABASE_ACCESS_TOKEN=sbp_... PROJECT_REF=<ref> SQL_FILE=path.sql tsx supabaseSql.ts
import { readFileSync } from 'node:fs';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.PROJECT_REF;
if (!token || !ref) {
  console.error('Need SUPABASE_ACCESS_TOKEN and PROJECT_REF env vars.');
  process.exit(1);
}
const query = process.env.SQL ?? (process.env.SQL_FILE ? readFileSync(process.env.SQL_FILE, 'utf8') : '');
if (!query) {
  console.error('Provide SQL=... or SQL_FILE=...');
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
});
const text = await res.text();
console.log('HTTP', res.status);
console.log(text.slice(0, 4000));
process.exitCode = res.ok ? 0 : 1; // set code; let the event loop drain cleanly
