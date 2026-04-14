import 'dotenv/config';
import { Pool } from 'pg';

export type NoteRecord = {
  id: number;
  content: string;
  created_at: string;
  updated_at: string;
};

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set in the server environment.');
}

export const pool = new Pool({
  connectionString: databaseUrl,
});

export async function ensureNotesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id BIGSERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
