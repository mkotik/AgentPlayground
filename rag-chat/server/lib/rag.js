const { PDFParse } = require('pdf-parse')
const { Pinecone } = require('@pinecone-database/pinecone')
const {
  DEFAULT_PINECONE_NAMESPACE,
  DEFAULT_RETRIEVAL_LIMIT,
  MIN_RETRIEVAL_SCORE,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  UPSERT_BATCH_SIZE,
  hasPineconeConfig,
} = require('./config')
const { createHttpError } = require('./http')
const { getEmbeddingModel } = require('./ai')
const { downloadFileBuffer } = require('./storage')
const {
  getFileRecordById,
  markFileProcessingStarted,
  markFileProcessingCompleted,
  markFileProcessingFailed,
} = require('./files')

let pineconeClient = null

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
    .filter((match) => {
      if (!match) {
        return false
      }

      if (typeof match.score !== 'number') {
        return true
      }

      return match.score >= MIN_RETRIEVAL_SCORE
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
    excerpt:
      chunk.text.length > 240 ? `${chunk.text.slice(0, 240).trim()}...` : chunk.text,
  }))
}

async function getPineconeHealth() {
  const health = {
    pineconeConfigured: hasPineconeConfig(),
    pineconeConnected: false,
    pineconeIndex: process.env.PINECONE_INDEX || null,
    pineconeNamespace: DEFAULT_PINECONE_NAMESPACE || null,
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

module.exports = {
  ingestFileRecord,
  retrieveRelevantChunks,
  buildRetrievedContext,
  serializeSources,
  getPineconeHealth,
}
