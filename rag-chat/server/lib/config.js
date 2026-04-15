if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Failed to load .env: ${error.message}`)
    }
  }
}

const PORT = Number(process.env.PORT ?? 3001)
const MAX_BODY_SIZE = 1_000_000
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'
const DEFAULT_EMBEDDING_MODEL =
  process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-small'
const DEFAULT_SYSTEM_PROMPT =
  process.env.OPENROUTER_SYSTEM_PROMPT ||
  'You are a concise, helpful assistant.'
const DEFAULT_UPLOAD_PREFIX = process.env.IDRIVE_E2_KEY_PREFIX || 'documents'
const DEFAULT_PINECONE_NAMESPACE = process.env.PINECONE_NAMESPACE || ''
const DEFAULT_RETRIEVAL_LIMIT = Number(process.env.RAG_TOP_K ?? 6)
const MIN_RETRIEVAL_SCORE = Number(process.env.RAG_MIN_SCORE ?? 0)
const CHUNK_SIZE = Number(process.env.RAG_CHUNK_SIZE ?? 1200)
const CHUNK_OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP ?? 200)
const UPSERT_BATCH_SIZE = 50

function hasPostgresConfig() {
  return Boolean(
    process.env.DATABASE_URL ||
      (process.env.PGHOST &&
        process.env.PGPORT &&
        process.env.PGDATABASE &&
        process.env.PGUSER &&
        process.env.PGPASSWORD),
  )
}

function hasPineconeConfig() {
  return Boolean(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX)
}

module.exports = {
  PORT,
  MAX_BODY_SIZE,
  DEFAULT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_UPLOAD_PREFIX,
  DEFAULT_PINECONE_NAMESPACE,
  DEFAULT_RETRIEVAL_LIMIT,
  MIN_RETRIEVAL_SCORE,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  UPSERT_BATCH_SIZE,
  hasPostgresConfig,
  hasPineconeConfig,
}
