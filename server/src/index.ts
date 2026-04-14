import express, { type Request, type Response } from 'express';
import { ensureNotesTable, pool, type NoteRecord } from './db.js';

const app = express();
const port = Number(process.env.PORT) || 3001;

app.use(express.json());

function parseContent(req: Request) {
  const content =
    typeof req.body?.content === 'string' ? req.body.content.trim() : '';

  if (!content) {
    return null;
  }

  return content;
}

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');

  res.status(200).json({
    ok: true,
    service: 'agent-playground-server',
  });
});

app.get('/api/notes', async (_req, res: Response<NoteRecord[]>) => {
  const result = await pool.query<NoteRecord>(
    'SELECT id, content, created_at, updated_at FROM notes ORDER BY updated_at DESC',
  );

  res.status(200).json(result.rows);
});

app.post('/api/notes', async (req, res) => {
  const content = parseContent(req);

  if (!content) {
    res.status(400).json({ error: 'Content is required.' });
    return;
  }

  const result = await pool.query<NoteRecord>(
    `
      INSERT INTO notes (content)
      VALUES ($1)
      RETURNING id, content, created_at, updated_at
    `,
    [content],
  );

  res.status(201).json(result.rows[0]);
});

app.put('/api/notes/:id', async (req, res) => {
  const noteId = Number(req.params.id);
  const content = parseContent(req);

  if (!Number.isInteger(noteId) || noteId <= 0) {
    res.status(400).json({ error: 'Valid note id is required.' });
    return;
  }

  if (!content) {
    res.status(400).json({ error: 'Content is required.' });
    return;
  }

  const result = await pool.query<NoteRecord>(
    `
      UPDATE notes
      SET content = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, content, created_at, updated_at
    `,
    [content, noteId],
  );

  if (!result.rows[0]) {
    res.status(404).json({ error: 'Note not found.' });
    return;
  }

  res.status(200).json(result.rows[0]);
});

app.delete('/api/notes/:id', async (req, res) => {
  const noteId = Number(req.params.id);

  if (!Number.isInteger(noteId) || noteId <= 0) {
    res.status(400).json({ error: 'Valid note id is required.' });
    return;
  }

  const result = await pool.query<NoteRecord>(
    'DELETE FROM notes WHERE id = $1 RETURNING id, content, created_at, updated_at',
    [noteId],
  );

  if (!result.rows[0]) {
    res.status(404).json({ error: 'Note not found.' });
    return;
  }

  res.status(200).json(result.rows[0]);
});

app.use((error: unknown, _req: Request, res: Response, _next: () => void) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

await ensureNotesTable();

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
