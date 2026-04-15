const crypto = require('crypto')
const http = require('http')
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

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
const DEFAULT_SYSTEM_PROMPT =
  process.env.OPENROUTER_SYSTEM_PROMPT ||
  'You are a concise, helpful assistant.'
const DEFAULT_UPLOAD_PREFIX = process.env.IDRIVE_E2_KEY_PREFIX || 'documents'

let modelPromise = null
let messagesModulePromise = null
let storageClient = null

function createHttpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
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
  if (!modelPromise) {
    modelPromise = import('@langchain/openai').then(({ ChatOpenAI }) => {
      const defaultHeaders = getOpenRouterHeaders()
      const configuration = {
        baseURL: 'https://openrouter.ai/api/v1',
      }

      if (Object.keys(defaultHeaders).length > 0) {
        configuration.defaultHeaders = defaultHeaders
      }

      return new ChatOpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        model: DEFAULT_MODEL,
        temperature: 0.7,
        configuration,
      })
    })
  }

  return modelPromise
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

async function toLangChainMessages(messages, systemPrompt) {
  const { AIMessage, HumanMessage, SystemMessage } = await getMessagesModule()
  const prompt =
    typeof systemPrompt === 'string' && systemPrompt.trim()
      ? systemPrompt.trim()
      : DEFAULT_SYSTEM_PROMPT

  return [
    new SystemMessage(prompt),
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
    sendJson(res, 200, {
      message: 'server is reachable',
      model: DEFAULT_MODEL,
      uploadsConfigured: hasUploadConfig(),
      timestamp: new Date().toISOString(),
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
        const promptMessages = await toLangChainMessages(
          messages,
          payload.systemPrompt,
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

  sendJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  console.log(`REST API listening on http://localhost:${PORT}`)
})
