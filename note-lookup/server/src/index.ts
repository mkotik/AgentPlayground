import express, { type Request, type Response } from 'express';
import { ensureNotesTable, pool, type NoteRecord, withTransaction } from './db.js';
import {
  deleteNoteFromVectorStore,
  getVectorSyncStatus,
  searchSimilarNotes,
  syncNoteToVectorStore,
} from './vector.js';

const app = express();
const port = Number(process.env.PORT) || 3001;

app.use(express.json());

function parseTextField(req: Request, fieldName: string) {
  const value =
    typeof req.body?.[fieldName] === 'string' ? req.body[fieldName].trim() : '';

  if (!value) {
    return null;
  }

  return value;
}

function parseContent(req: Request) {
  return parseTextField(req, 'content');
}

function parseQuery(req: Request) {
  return parseTextField(req, 'query');
}

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');

  res.status(200).json({
    ok: true,
    service: 'agent-playground-server',
    vectorSync: getVectorSyncStatus(),
  });
});

app.get('/api/notes', async (_req, res: Response<NoteRecord[]>) => {
  const result = await pool.query<NoteRecord>(
    'SELECT id, content, created_at, updated_at FROM notes ORDER BY updated_at DESC',
  );

  res.status(200).json(result.rows);
});

app.post('/api/notes/search', async (req, res) => {
  const query = parseQuery(req);

  if (!query) {
    res.status(400).json({ error: 'Query is required.' });
    return;
  }

  if (!getVectorSyncStatus().enabled) {
    res.status(503).json({ error: 'Vector search is not configured.' });
    return;
  }

  const matches = await searchSimilarNotes(query);

  if (matches.length === 0) {
    res.status(404).json({ error: 'No similar notes found.' });
    return;
  }

  const noteIds = matches.map((match) => match.noteId);
  const result = await pool.query<NoteRecord>(
    `
      SELECT id, content, created_at, updated_at
      FROM notes
      WHERE id = ANY($1::bigint[])
    `,
    [noteIds],
  );

  const notesById = new Map(
    result.rows.map((note) => [Number(note.id), note] as const),
  );
  const bestMatch = matches.find((match) => notesById.has(match.noteId));

  if (!bestMatch) {
    res.status(404).json({ error: 'No similar notes found.' });
    return;
  }

  res.status(200).json({
    query,
    score: bestMatch.score,
    note: notesById.get(bestMatch.noteId),
  });
});

app.post('/api/notes', async (req, res) => {
  const content = parseContent(req);

  if (!content) {
    res.status(400).json({ error: 'Content is required.' });
    return;
  }

  const note = await withTransaction(async (client) => {
    const result = await client.query<NoteRecord>(
      `
        INSERT INTO notes (content)
        VALUES ($1)
        RETURNING id, content, created_at, updated_at
      `,
      [content],
    );

    const nextNote = result.rows[0];

    if (!nextNote) {
      throw new Error('Failed to create note.');
    }

    await syncNoteToVectorStore(nextNote);
    return nextNote;
  });

  res.status(201).json(note);
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

  const note = await withTransaction(async (client) => {
    const result = await client.query<NoteRecord>(
      `
        UPDATE notes
        SET content = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, content, created_at, updated_at
      `,
      [content, noteId],
    );

    const nextNote = result.rows[0];

    if (!nextNote) {
      return null;
    }

    await syncNoteToVectorStore(nextNote);
    return nextNote;
  });

  if (!note) {
    res.status(404).json({ error: 'Note not found.' });
    return;
  }

  res.status(200).json(note);
});

app.delete('/api/notes/:id', async (req, res) => {
  const noteId = Number(req.params.id);

  if (!Number.isInteger(noteId) || noteId <= 0) {
    res.status(400).json({ error: 'Valid note id is required.' });
    return;
  }

  const note = await withTransaction(async (client) => {
    const result = await client.query<NoteRecord>(
      'DELETE FROM notes WHERE id = $1 RETURNING id, content, created_at, updated_at',
      [noteId],
    );

    const deletedNote = result.rows[0];

    if (!deletedNote) {
      return null;
    }

    await deleteNoteFromVectorStore(noteId);
    return deletedNote;
  });

  if (!note) {
    res.status(404).json({ error: 'Note not found.' });
    return;
  }

  res.status(200).json(note);
});

app.use((error: unknown, _req: Request, res: Response, _next: () => void) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

await ensureNotesTable();

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
