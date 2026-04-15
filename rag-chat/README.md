# rag-chat

Minimal full-stack chat app using OpenRouter on the server through LangChain, with synchronous PDF ingestion for basic RAG.

## Structure

- `client`: React + TypeScript + Vite app
- `server`: Node REST API for chat, uploads, Postgres file metadata, synchronous PDF ingestion, and Pinecone retrieval

## Run

In one terminal:

```bash
cd server
npm install
OPENROUTER_API_KEY=your_key_here npm run dev
```

In another terminal:

```bash
cd client
npm install
npm run dev
```

Open the Vite URL, usually `http://localhost:5173`. Enter a prompt in the text area and the client will send the full transcript to `POST /api/chat`.

## Environment

- `OPENROUTER_API_KEY` is required.
- `OPENROUTER_MODEL` is optional. Default: `openai/gpt-4o-mini`
- `OPENROUTER_EMBEDDING_MODEL` is optional. Default: `openai/text-embedding-3-small`
- `OPENROUTER_APP_URL` is optional and forwarded as `HTTP-Referer`.
- `OPENROUTER_APP_NAME` is optional and forwarded as `X-Title`.
- `IDRIVE_E2_BUCKET` is required for PDF uploads.
- `IDRIVE_E2_ENDPOINT` is required for PDF uploads.
- `IDRIVE_E2_REGION` is required for PDF uploads.
- `IDRIVE_E2_ACCESS_KEY_ID` is required for PDF uploads.
- `IDRIVE_E2_SECRET_ACCESS_KEY` is required for PDF uploads.
- `IDRIVE_E2_KEY_PREFIX` is optional. Default: `documents`
- `DATABASE_URL` is optional if you provide the individual Postgres variables instead.
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` configure Postgres when `DATABASE_URL` is not used.
- `PGSSL=require` enables SSL for Postgres.
- `PINECONE_API_KEY` is required for Pinecone connectivity.
- `PINECONE_INDEX` is the Pinecone index used for chunk embeddings and retrieval.
- `PINECONE_NAMESPACE` is optional if you want to isolate vectors in a namespace.
- `RAG_TOP_K` is optional. Default: `6`
- `RAG_CHUNK_SIZE` is optional. Default: `1200`
- `RAG_CHUNK_OVERLAP` is optional. Default: `200`

The browser sends the full chat transcript to `POST /api/chat`. The server embeds the latest user message, retrieves matching chunks from Pinecone, injects them into the prompt, and returns the assistant reply.

## PDF Uploads

The upload panel asks the server for a presigned URL, then the browser uploads the PDF directly to IDrive E2 with `PUT`.

After the upload succeeds, the client calls `POST /api/files` with `ingest: true`. The server then:

- stores the file metadata in Postgres
- downloads the PDF back from object storage
- extracts text synchronously
- chunks the text
- generates embeddings through OpenRouter
- writes those vectors into Pinecone

For local development, configure Bucket CORS in IDrive E2 so your frontend origin can upload directly. At minimum, allow:

- Origin: `http://localhost:5173`
- Method: `PUT`
- Header: `Content-Type`

## File Metadata And Ingestion

The server now persists uploaded file metadata in Postgres. There is still no dedicated migration system in the repo, so on first use the server creates the `files` table automatically and adds any missing ingestion columns with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

- `POST /api/files` stores file metadata such as `fileName`, `storageKey`, `storageUrl`, `contentType`, and `sizeBytes`.
- `POST /api/files` also accepts `ingest: true` to synchronously parse, chunk, embed, and index the uploaded PDF.
- `POST /api/files/:id/ingest` retries ingestion for an existing file record.
- `GET /api/files` returns the latest 100 file records.
- `GET /api/health` now reports whether Postgres and Pinecone are configured and reachable.

Example metadata payload:

```json
{
  "fileName": "report.pdf",
  "storageKey": "documents/2026-04-14/uuid-report.pdf",
  "storageUrl": "https://bucket.example.com/documents/2026-04-14/uuid-report.pdf",
  "contentType": "application/pdf",
  "sizeBytes": 245760,
  "uploadStatus": "uploaded",
  "ingest": true
}
```
