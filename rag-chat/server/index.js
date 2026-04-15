const http = require('http')

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

let modelPromise = null
let messagesModulePromise = null

function createHttpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
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
      timestamp: new Date().toISOString(),
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
