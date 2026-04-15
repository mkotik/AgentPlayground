const crypto = require('crypto')
const http = require('http')
const { PDFParse } = require('pdf-parse')
const {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const { Pool } = require('pg')
const { Pinecone } = require('@pinecone-database/pinecone')

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
const CHUNK_SIZE = Number(process.env.RAG_CHUNK_SIZE ?? 1200)
const CHUNK_OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP ?? 200)
const UPSERT_BATCH_SIZE = 50

let chatModelPromise = null
let embeddingModelPromise = null
let messagesModulePromise = null
let storageClient = null
let postgresPool = null
let pineconeClient = null
let filesTableReadyPromise = null

function createHttpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

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

function getRequiredUploadConfig() {
  const config = {
    bucket: process.env.IDRIVE_E2_BUCKET,
    endpoint: process.env.IDRIVE_E2_ENDPOINT,
    region: process.env.IDRIVE_E2_REGION,
    accessKeyId: process.env.IDRIVE_E2_ACCESS_KEY_ID,
    secretAccessKey: process.env.IDRIVE_E2_SECRET_ACCESS_KEY,
  }
  const missing = Object.entries({
    IDRIVE_E2_BUCKET: config.bucket,
    IDRIVE_E2_ENDPOINT: config.endpoint,
    IDRIVE_E2_REGION: config.region,
    IDRIVE_E2_ACCESS_KEY_ID: config.accessKeyId,
    IDRIVE_E2_SECRET_ACCESS_KEY: config.secretAccessKey,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length > 0) {
    throw createHttpError(
      500,
      `Missing ${missing.join(', ')} in the server environment`,
    )
  }

  return config
}

function normalizeStorageEndpoint(endpoint) {
  const value = typeof endpoint === 'string' ? endpoint.trim() : ''
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`

  try {
    return new URL(withProtocol).toString().replace(/\/$/, '')
  } catch (error) {
    throw createHttpError(
      500,
      'IDRIVE_E2_ENDPOINT must be a valid URL like https://your-endpoint.example.com',
    )
  }
}

function hasUploadConfig() {
  try {
    getRequiredUploadConfig()
    return true
  } catch (error) {
    return false
  }
}

function getPostgresPool() {
  if (!hasPostgresConfig()) {
    throw createHttpError(
      500,
      'Missing DATABASE_URL or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD in the server environment',
    )
  }

  if (!postgresPool) {
    postgresPool = process.env.DATABASE_URL
      ? new Pool({
          connectionString: process.env.DATABASE_URL,
        })
      : new Pool({
          host: process.env.PGHOST,
          port: Number(process.env.PGPORT),
          database: process.env.PGDATABASE,
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          ssl:
            process.env.PGSSL === 'require'
              ? { rejectUnauthorized: false }
              : undefined,
        })
  }

  return postgresPool
}

async function ensureFilesTable() {
  if (!filesTableReadyPromise) {
    const pool = getPostgresPool()

    filesTableReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS files (
          id UUID PRIMARY KEY,
          file_name TEXT NOT NULL,
          storage_bucket TEXT,
          storage_key TEXT NOT NULL,
          storage_url TEXT,
          content_type TEXT,
          size_bytes BIGINT,
          upload_status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)

      await pool.query(`
        ALTER TABLE files
        ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS processing_error TEXT,
        ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS page_count INTEGER,
        ADD COLUMN IF NOT EXISTS chunk_count INTEGER
      `)
    })()
  }

  await filesTableReadyPromise
}

function getPineconeClient() {
  if (!hasPineconeConfig()) {
    throw createHttpError(
      500,
      'Missing PINECONE_API_KEY or PINECONE_INDEX in the server environment',
    )
  }

  if (!pineconeClient) {
    pineconeClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    })
  }

  return pineconeClient
}

function getPineconeIndex() {
  const client = getPineconeClient()
  return client.index(process.env.PINECONE_INDEX)
}

function getPineconeNamespace() {
  const index = getPineconeIndex()
  return DEFAULT_PINECONE_NAMESPACE
    ? index.namespace(DEFAULT_PINECONE_NAMESPACE)
    : index
}

function normalizeServiceError(error, fallbackMessage) {
  const message = error?.message || fallbackMessage

  if (
    error?.name === 'PineconeNotFoundError' ||
    (typeof message === 'string' &&
      message.includes('api.pinecone.io/indexes/') &&
      message.includes('returned HTTP status 404'))
  ) {
    return createHttpError(
      500,
      `Pinecone index "${process.env.PINECONE_INDEX}" was not found. Create that index in Pinecone or update PINECONE_INDEX to an existing one.`,
    )
  }

  return error
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''

    req.on('data', (chunk) => {
      body += chunk

      if (body.length > MAX_BODY_SIZE) {
        reject(createHttpError(413, 'Request body too large'))
        req.destroy()
      }
    })

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(createHttpError(400, 'Request body must be valid JSON'))
      }
    })

    req.on('error', reject)
  })
}

function getOpenRouterHeaders() {
  const headers = {}

  if (process.env.OPENROUTER_APP_URL) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_APP_URL
  }

  if (process.env.OPENROUTER_APP_NAME) {
    headers['X-Title'] = process.env.OPENROUTER_APP_NAME
  }

  return headers
}

function getOpenRouterConfiguration() {
  const defaultHeaders = getOpenRouterHeaders()
  const configuration = {
    baseURL: 'https://openrouter.ai/api/v1',
  }

  if (Object.keys(defaultHeaders).length > 0) {
    configuration.defaultHeaders = defaultHeaders
  }

  return configuration
}

function getStorageClient() {
  if (!storageClient) {
    const config = getRequiredUploadConfig()

    storageClient = new S3Client({
      region: config.region,
      endpoint: normalizeStorageEndpoint(config.endpoint),
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }

  return storageClient
}

async function getChatModel() {
  if (!chatModelPromise) {
    chatModelPromise = import('@langchain/openai').then(({ ChatOpenAI }) => {
      return new ChatOpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        model: DEFAULT_MODEL,
        temperature: 0.7,
        configuration: getOpenRouterConfiguration(),
      })
    })
  }

  return chatModelPromise
}

async function getEmbeddingModel() {
  if (!embeddingModelPromise) {
    embeddingModelPromise = import('@langchain/openai').then(
      ({ OpenAIEmbeddings }) => {
        return new OpenAIEmbeddings({
          apiKey: process.env.OPENROUTER_API_KEY,
          model: DEFAULT_EMBEDDING_MODEL,
          configuration: getOpenRouterConfiguration(),
        })
      },
    )
  }

  return embeddingModelPromise
}

async function getMessagesModule() {
  if (!messagesModulePromise) {
    messagesModulePromise = import('@langchain/core/messages')
  }

  return messagesModulePromise
}

function normalizeIncomingMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw createHttpError(
      400,
      'Request must include a non-empty messages array',
    )
  }

  return messages.map((message, index) => {
    const role = message?.role
    const content =
      typeof message?.content === 'string' ? message.content.trim() : ''

    if (!['user', 'assistant'].includes(role)) {
      throw createHttpError(
        400,
        `Message ${index + 1} has an unsupported role`,
      )
    }

    if (!content) {
      throw createHttpError(
        400,
        `Message ${index + 1} must include text content`,
      )
    }

    return { role, content }
  })
}

async function toLangChainMessages(messages, systemPrompt, retrievedContext) {
  const { AIMessage, HumanMessage, SystemMessage } = await getMessagesModule()
  const prompt =
    typeof systemPrompt === 'string' && systemPrompt.trim()
      ? systemPrompt.trim()
      : DEFAULT_SYSTEM_PROMPT

  const contextSection =
    typeof retrievedContext === 'string' && retrievedContext.trim()
      ? `\n\nRetrieved context:\n${retrievedContext.trim()}\n\nUse the retrieved context when it is relevant to the user's request. If the context is insufficient, say so plainly and do not invent citations or facts.`
      : ''

  return [
    new SystemMessage(`${prompt}${contextSection}`),
    ...messages.map((message) => {
      if (message.role === 'assistant') {
        return new AIMessage(message.content)
      }

      return new HumanMessage(message.content)
    }),
  ]
}

function getTextFromContent(content) {
  if (typeof content === 'string') {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part
      }

      if (part?.type === 'text' && typeof part.text === 'string') {
        return part.text
      }

      return ''
    })
    .join('\n')
    .trim()
}

function normalizeUploadPrefix(prefix) {
  return prefix.replace(/^\/+|\/+$/g, '')
}

function sanitizeFileName(fileName) {
  const rawFileName =
    typeof fileName === 'string' && fileName.trim()
      ? fileName.trim().split(/[\\/]/).pop()
      : 'document.pdf'
  const withExtension = rawFileName.toLowerCase().endsWith('.pdf')
    ? rawFileName
    : `${rawFileName}.pdf`
  const sanitized = withExtension
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return sanitized || 'document.pdf'
}

function isPdfUpload(fileName, contentType) {
  if (typeof fileName !== 'string' || !fileName.toLowerCase().endsWith('.pdf')) {
    return false
  }

  if (typeof contentType !== 'string' || !contentType.trim()) {
    return true
  }

  return ['application/pdf', 'application/x-pdf'].includes(
    contentType.toLowerCase(),
  )
}

async function createPresignedUpload(fileName, contentType) {
  const config = getRequiredUploadConfig()
  const normalizedContentType =
    typeof contentType === 'string' && contentType.trim()
      ? contentType.trim()
      : 'application/pdf'
  const keyPrefix = normalizeUploadPrefix(DEFAULT_UPLOAD_PREFIX)
  const dateSegment = new Date().toISOString().slice(0, 10)
  const objectKey = [
    keyPrefix,
    dateSegment,
    `${crypto.randomUUID()}-${sanitizeFileName(fileName)}`,
  ]
    .filter(Boolean)
    .join('/')
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    ContentType: normalizedContentType,
  })
  const uploadUrl = await getSignedUrl(getStorageClient(), command, {
    expiresIn: 300,
  })

  return {
    uploadUrl,
    objectKey,
    method: 'PUT',
    headers: {
      'Content-Type': normalizedContentType,
    },
  }
}

function parseOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseOptionalInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  if (typeof value !== 'number' && typeof value !== 'string') {
    throw createHttpError(400, 'sizeBytes must be a number')
  }

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw createHttpError(400, 'sizeBytes must be a non-negative integer')
  }

  return parsed
}

function normalizeFileRecord(payload) {
  const fileName =
    typeof payload?.fileName === 'string' ? payload.fileName.trim() : ''
  const storageKey =
    typeof payload?.storageKey === 'string' ? payload.storageKey.trim() : ''

  if (!fileName) {
    throw createHttpError(400, 'fileName is required')
  }

  if (!storageKey) {
    throw createHttpError(400, 'storageKey is required')
  }

  return {
    id: crypto.randomUUID(),
    fileName,
    storageBucket:
      parseOptionalString(payload.storageBucket) || process.env.IDRIVE_E2_BUCKET || null,
    storageKey,
    storageUrl: parseOptionalString(payload.storageUrl),
    contentType: parseOptionalString(payload.contentType),
    sizeBytes: parseOptionalInteger(payload.sizeBytes),
    uploadStatus: parseOptionalString(payload.uploadStatus) || 'uploaded',
    processingStatus: 'pending',
  }
}

async function saveFileRecord(payload) {
  const file = normalizeFileRecord(payload)

  await ensureFilesTable()

  const pool = getPostgresPool()
  const result = await pool.query(
    `
      INSERT INTO files (
        id,
        file_name,
        storage_bucket,
        storage_key,
        storage_url,
        content_type,
        size_bytes,
        upload_status,
        processing_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING
        id,
        file_name AS "fileName",
        storage_bucket AS "storageBucket",
        storage_key AS "storageKey",
        storage_url AS "storageUrl",
        content_type AS "contentType",
        size_bytes AS "sizeBytes",
        upload_status AS "uploadStatus",
        processing_status AS "processingStatus",
        processing_error AS "processingError",
        processing_started_at AS "processingStartedAt",
        processing_completed_at AS "processingCompletedAt",
        page_count AS "pageCount",
        chunk_count AS "chunkCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
    [
      file.id,
      file.fileName,
      file.storageBucket,
      file.storageKey,
      file.storageUrl,
      file.contentType,
      file.sizeBytes,
      file.uploadStatus,
      file.processingStatus,
    ],
  )

  return result.rows[0]
}

async function listFileRecords() {
  await ensureFilesTable()

  const pool = getPostgresPool()
  const result = await pool.query(
    `
      SELECT
        id,
        file_name AS "fileName",
        storage_bucket AS "storageBucket",
        storage_key AS "storageKey",
        storage_url AS "storageUrl",
        content_type AS "contentType",
        size_bytes AS "sizeBytes",
        upload_status AS "uploadStatus",
        processing_status AS "processingStatus",
        processing_error AS "processingError",
        processing_started_at AS "processingStartedAt",
        processing_completed_at AS "processingCompletedAt",
        page_count AS "pageCount",
        chunk_count AS "chunkCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM files
      ORDER BY created_at DESC
      LIMIT 100
    `,
  )

  return result.rows
}

async function getFileRecordById(fileId) {
  await ensureFilesTable()

  const pool = getPostgresPool()
  const result = await pool.query(
    `
      SELECT
        id,
        file_name AS "fileName",
        storage_bucket AS "storageBucket",
        storage_key AS "storageKey",
        storage_url AS "storageUrl",
        content_type AS "contentType",
        size_bytes AS "sizeBytes",
        upload_status AS "uploadStatus",
        processing_status AS "processingStatus",
        processing_error AS "processingError",
        processing_started_at AS "processingStartedAt",
        processing_completed_at AS "processingCompletedAt",
        page_count AS "pageCount",
        chunk_count AS "chunkCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM files
      WHERE id = $1
    `,
    [fileId],
  )

  return result.rows[0] || null
}

async function markFileProcessingStarted(fileId) {
  const pool = getPostgresPool()
  await pool.query(
    `
      UPDATE files
      SET
        processing_status = 'processing',
        processing_error = NULL,
        processing_started_at = NOW(),
        processing_completed_at = NULL,
        updated_at = NOW()
      WHERE id = $1
    `,
    [fileId],
  )
}

async function markFileProcessingCompleted(fileId, pageCount, chunkCount) {
  const pool = getPostgresPool()
  await pool.query(
    `
      UPDATE files
      SET
        processing_status = 'completed',
        processing_error = NULL,
        processing_completed_at = NOW(),
        page_count = $2,
        chunk_count = $3,
        updated_at = NOW()
      WHERE id = $1
    `,
    [fileId, pageCount, chunkCount],
  )
}

async function markFileProcessingFailed(fileId, error) {
  const pool = getPostgresPool()
  await pool.query(
    `
      UPDATE files
      SET
        processing_status = 'failed',
        processing_error = $2,
        processing_completed_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [fileId, error.message || 'Processing failed'],
  )
}

async function streamToBuffer(body) {
  if (!body) {
    throw new Error('Storage response body is empty')
  }

  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray()
    return Buffer.from(bytes)
  }

  const chunks = []

  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

async function downloadFileBuffer(file) {
  const bucket = file.storageBucket || process.env.IDRIVE_E2_BUCKET

  if (!bucket) {
    throw createHttpError(500, 'No storage bucket configured for file ingestion')
  }

  const response = await getStorageClient().send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: file.storageKey,
    }),
  )

  return streamToBuffer(response.Body)
}

function normalizePdfText(text) {
  return String(text || '')
    .replace(/\u0000/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function splitTextIntoChunks(text) {
  const normalized = normalizePdfText(text)

  if (!normalized) {
    return []
  }

  const chunks = []
  let start = 0

  while (start < normalized.length) {
    const tentativeEnd = Math.min(start + CHUNK_SIZE, normalized.length)
    let end = tentativeEnd

    if (tentativeEnd < normalized.length) {
      const floor = start + Math.floor(CHUNK_SIZE * 0.6)
      const newline = normalized.lastIndexOf('\n', tentativeEnd)
      const sentence = normalized.lastIndexOf('. ', tentativeEnd)
      const space = normalized.lastIndexOf(' ', tentativeEnd)
      const boundary = [newline, sentence >= 0 ? sentence + 1 : -1, space]
        .filter((value) => value >= floor)
        .sort((left, right) => right - left)[0]

      if (boundary) {
        end = boundary
      }
    }

    const content = normalized.slice(start, end).trim()

    if (content) {
      chunks.push({
        chunkIndex: chunks.length,
        text: content,
      })
    }

    if (end >= normalized.length) {
      break
    }

    start = Math.max(end - CHUNK_OVERLAP, start + 1)
  }

  return chunks
}

async function parsePdfBuffer(buffer) {
  const parser = new PDFParse({ data: buffer })
  let parsed

  try {
    parsed = await parser.getText()
  } finally {
    await parser.destroy().catch(() => {})
  }

  const text = normalizePdfText(parsed.text)

  if (!text) {
    throw createHttpError(422, 'The PDF did not contain extractable text')
  }

  return {
    text,
    pageCount:
      typeof parsed.numpages === 'number' && Number.isFinite(parsed.numpages)
        ? parsed.numpages
        : null,
  }
}

function getChunkVectorId(fileId, chunkIndex) {
  return `${fileId}:chunk:${chunkIndex}`
}

async function upsertFileChunks(file, chunks) {
  if (chunks.length === 0) {
    throw createHttpError(422, 'No text chunks were generated from the PDF')
  }

  const embeddings = await getEmbeddingModel()
  const vectors = await embeddings.embedDocuments(chunks.map((chunk) => chunk.text))
  const namespace = getPineconeNamespace()

  for (let index = 0; index < chunks.length; index += UPSERT_BATCH_SIZE) {
    const chunkBatch = chunks.slice(index, index + UPSERT_BATCH_SIZE)
    const vectorBatch = vectors.slice(index, index + UPSERT_BATCH_SIZE)

    await namespace.upsert(
      chunkBatch.map((chunk, batchIndex) => ({
        id: getChunkVectorId(file.id, chunk.chunkIndex),
        values: vectorBatch[batchIndex],
        metadata: {
          fileId: file.id,
          fileName: file.fileName,
          storageKey: file.storageKey,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
        },
      })),
    )
  }
}

async function ingestFileRecord(fileId) {
  if (!hasPineconeConfig()) {
    throw createHttpError(
      500,
      'Missing PINECONE_API_KEY or PINECONE_INDEX in the server environment',
    )
  }

  if (!process.env.OPENROUTER_API_KEY) {
    throw createHttpError(
      500,
      'Missing OPENROUTER_API_KEY in the server environment',
    )
  }

  const file = await getFileRecordById(fileId)

  if (!file) {
    throw createHttpError(404, 'File not found')
  }

  await markFileProcessingStarted(fileId)

  try {
    const fileBuffer = await downloadFileBuffer(file)
    const parsed = await parsePdfBuffer(fileBuffer)
    const chunks = splitTextIntoChunks(parsed.text)

    await upsertFileChunks(file, chunks)
    await markFileProcessingCompleted(fileId, parsed.pageCount, chunks.length)

    return getFileRecordById(fileId)
  } catch (error) {
    const normalizedError = normalizeServiceError(error, 'File ingestion failed')
    await markFileProcessingFailed(fileId, normalizedError)
    throw normalizedError
  }
}

async function retrieveRelevantChunks(queryText) {
  if (!hasPineconeConfig() || !process.env.OPENROUTER_API_KEY) {
    return []
  }

  const trimmedQuery = typeof queryText === 'string' ? queryText.trim() : ''

  if (!trimmedQuery) {
    return []
  }

  const embeddings = await getEmbeddingModel()
  const vector = await embeddings.embedQuery(trimmedQuery)
  const namespace = getPineconeNamespace()
  let response

  try {
    response = await namespace.query({
      topK: DEFAULT_RETRIEVAL_LIMIT,
      vector,
      includeMetadata: true,
    })
  } catch (error) {
    throw normalizeServiceError(error, 'Pinecone query failed')
  }

  return (response.matches || [])
    .map((match) => {
      const metadata = match.metadata || {}
      const text = typeof metadata.text === 'string' ? metadata.text.trim() : ''

      if (!text) {
        return null
      }

      return {
        id: match.id,
        score: typeof match.score === 'number' ? match.score : null,
        fileId: typeof metadata.fileId === 'string' ? metadata.fileId : null,
        fileName:
          typeof metadata.fileName === 'string' ? metadata.fileName : 'Unknown document',
        storageKey:
          typeof metadata.storageKey === 'string' ? metadata.storageKey : null,
        chunkIndex:
          typeof metadata.chunkIndex === 'number' ? metadata.chunkIndex : null,
        text,
      }
    })
    .filter(Boolean)
}

function buildRetrievedContext(chunks) {
  return chunks
    .map((chunk, index) => {
      const fileLabel = chunk.fileName || 'Unknown document'
      const chunkLabel =
        typeof chunk.chunkIndex === 'number'
          ? `chunk ${chunk.chunkIndex + 1}`
          : `match ${index + 1}`

      return `[Source ${index + 1}: ${fileLabel}, ${chunkLabel}]\n${chunk.text}`
    })
    .join('\n\n')
}

function serializeSources(chunks) {
  return chunks.map((chunk) => ({
    id: chunk.id,
    fileId: chunk.fileId,
    fileName: chunk.fileName,
    storageKey: chunk.storageKey,
    chunkIndex: chunk.chunkIndex,
    score: chunk.score,
  }))
}

async function getServiceHealth() {
  const health = {
    postgresConfigured: hasPostgresConfig(),
    postgresConnected: false,
    pineconeConfigured: hasPineconeConfig(),
    pineconeConnected: false,
    pineconeIndex: process.env.PINECONE_INDEX || null,
    pineconeNamespace: DEFAULT_PINECONE_NAMESPACE || null,
  }

  if (health.postgresConfigured) {
    try {
      await ensureFilesTable()
      health.postgresConnected = true
    } catch (error) {
      console.error('Postgres health check failed', error)
    }
  }

  if (health.pineconeConfigured) {
    try {
      const index = getPineconeIndex()
      await index.describeIndexStats()
      health.pineconeConnected = true
    } catch (error) {
      console.error(
        'Pinecone health check failed',
        normalizeServiceError(error, 'Pinecone health check failed'),
      )
    }
  }

  return health
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    getServiceHealth()
      .then((serviceHealth) => {
        sendJson(res, 200, {
          message: 'server is reachable',
          model: DEFAULT_MODEL,
          embeddingModel: DEFAULT_EMBEDDING_MODEL,
          uploadsConfigured: hasUploadConfig(),
          timestamp: new Date().toISOString(),
          ...serviceHealth,
        })
      })
      .catch((error) => {
        console.error(error)
        sendJson(res, 500, {
          error: error.message || 'Health check failed',
        })
      })
    return
  }

  if (req.method === 'POST' && req.url === '/api/uploads/presign') {
    readJsonBody(req)
      .then(async (payload) => {
        const fileName =
          typeof payload.fileName === 'string' ? payload.fileName.trim() : ''
        const contentType =
          typeof payload.contentType === 'string'
            ? payload.contentType.trim()
            : 'application/pdf'

        if (!fileName) {
          throw createHttpError(400, 'fileName is required')
        }

        if (!isPdfUpload(fileName, contentType)) {
          throw createHttpError(400, 'Only PDF uploads are supported')
        }

        const upload = await createPresignedUpload(fileName, contentType)

        sendJson(res, 200, upload)
      })
      .catch((error) => {
        console.error(error)
        sendJson(res, error.statusCode || 500, {
          error: error.message || 'Could not create an upload URL',
        })
      })

    return
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    if (!process.env.OPENROUTER_API_KEY) {
      sendJson(res, 500, {
        error: 'Missing OPENROUTER_API_KEY in the server environment',
      })
      return
    }

    readJsonBody(req)
      .then(async (payload) => {
        const messages = normalizeIncomingMessages(payload.messages)
        const latestUserMessage = [...messages]
          .reverse()
          .find((message) => message.role === 'user')
        const retrievedChunks = latestUserMessage
          ? await retrieveRelevantChunks(latestUserMessage.content)
          : []
        const promptMessages = await toLangChainMessages(
          messages,
          payload.systemPrompt,
          buildRetrievedContext(retrievedChunks),
        )
        const model = await getChatModel()
        const response = await model.invoke(promptMessages)
        const content = getTextFromContent(response.content)

        if (!content) {
          throw new Error('The model returned an empty response')
        }

        sendJson(res, 200, {
          message: {
            role: 'assistant',
            content,
            sources: serializeSources(retrievedChunks),
          },
        })
      })
      .catch((error) => {
        console.error(error)
        sendJson(res, error.statusCode || 500, {
          error: error.message || 'Chat request failed',
        })
      })

    return
  }

  if (req.method === 'GET' && req.url === '/api/files') {
    listFileRecords()
      .then((files) => {
        sendJson(res, 200, { files })
      })
      .catch((error) => {
        console.error(error)
        sendJson(res, error.statusCode || 500, {
          error: error.message || 'Could not list files',
        })
      })

    return
  }

  if (req.method === 'POST' && req.url === '/api/files') {
    readJsonBody(req)
      .then(async (payload) => {
        const file = await saveFileRecord(payload)
        const shouldIngest = payload?.ingest === true
        const ingestedFile = shouldIngest ? await ingestFileRecord(file.id) : file

        sendJson(res, 201, { file: ingestedFile })
      })
      .catch((error) => {
        console.error(error)
        sendJson(res, error.statusCode || 500, {
          error: error.message || 'Could not save file metadata',
        })
      })

    return
  }

  const ingestMatch =
    req.method === 'POST' ? req.url.match(/^\/api\/files\/([^/]+)\/ingest$/) : null

  if (ingestMatch) {
    ingestFileRecord(ingestMatch[1])
      .then((file) => {
        sendJson(res, 200, { file })
      })
      .catch((error) => {
        console.error(error)
        sendJson(res, error.statusCode || 500, {
          error: error.message || 'Could not ingest file',
        })
      })

    return
  }

  sendJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  console.log(`REST API listening on http://localhost:${PORT}`)
})
