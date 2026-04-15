const http = require('http')
const { PORT, DEFAULT_MODEL, DEFAULT_EMBEDDING_MODEL, hasPostgresConfig } = require('./lib/config')
const { createHttpError, sendJson, readJsonBody } = require('./lib/http')
const { hasUploadConfig, isPdfUpload, createPresignedUpload } = require('./lib/storage')
const {
  getChatModel,
  normalizeIncomingMessages,
  toLangChainMessages,
  getTextFromContent,
} = require('./lib/ai')
const {
  ensureFilesTable,
  listFileRecords,
  saveFileRecord,
} = require('./lib/files')
const {
  ingestFileRecord,
  retrieveRelevantChunks,
  buildRetrievedContext,
  serializeSources,
  getPineconeHealth,
} = require('./lib/rag')

async function getServiceHealth() {
  const health = {
    postgresConfigured: hasPostgresConfig(),
    postgresConnected: false,
  }

  if (health.postgresConfigured) {
    try {
      await ensureFilesTable()
      health.postgresConnected = true
    } catch (error) {
      console.error('Postgres health check failed', error)
    }
  }

  return {
    ...health,
    ...(await getPineconeHealth()),
  }
}

function handleHealth(req, res) {
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
}

function handlePresignUpload(req, res) {
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

      sendJson(res, 200, await createPresignedUpload(fileName, contentType))
    })
    .catch((error) => {
      console.error(error)
      sendJson(res, error.statusCode || 500, {
        error: error.message || 'Could not create an upload URL',
      })
    })
}

function handleChat(req, res) {
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
        retrieval: {
          query: latestUserMessage?.content || '',
          sourceCount: retrievedChunks.length,
          usedContext: retrievedChunks.length > 0,
        },
      })
    })
    .catch((error) => {
      console.error(error)
      sendJson(res, error.statusCode || 500, {
        error: error.message || 'Chat request failed',
      })
    })
}

function handleListFiles(req, res) {
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
}

function handleCreateFile(req, res) {
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
}

function handleIngestFile(req, res, fileId) {
  ingestFileRecord(fileId)
    .then((file) => {
      sendJson(res, 200, { file })
    })
    .catch((error) => {
      console.error(error)
      sendJson(res, error.statusCode || 500, {
        error: error.message || 'Could not ingest file',
      })
    })
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
    handleHealth(req, res)
    return
  }

  if (req.method === 'POST' && req.url === '/api/uploads/presign') {
    handlePresignUpload(req, res)
    return
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    handleChat(req, res)
    return
  }

  if (req.method === 'GET' && req.url === '/api/files') {
    handleListFiles(req, res)
    return
  }

  if (req.method === 'POST' && req.url === '/api/files') {
    handleCreateFile(req, res)
    return
  }

  const ingestMatch =
    req.method === 'POST' ? req.url.match(/^\/api\/files\/([^/]+)\/ingest$/) : null

  if (ingestMatch) {
    handleIngestFile(req, res, ingestMatch[1])
    return
  }

  sendJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  console.log(`REST API listening on http://localhost:${PORT}`)
})
