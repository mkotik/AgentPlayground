import { ensureNotesTable, pool } from './db.js';

await ensureNotesTable();
await pool.end();

console.log('Notes table is ready.');
