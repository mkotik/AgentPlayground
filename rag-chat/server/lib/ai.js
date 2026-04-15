const {
  DEFAULT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_SYSTEM_PROMPT,
} = require('./config')
const { createHttpError } = require('./http')

let chatModelPromise = null
let embeddingModelPromise = null
let messagesModulePromise = null

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
      ? `\n\nRetrieved context:\n${retrievedContext.trim()}\n\nUse the retrieved context when it is relevant to the user's request. Prefer grounding claims in the retrieved material and cite sources inline like [Source 1] when the answer depends on them. If the context is insufficient, say so plainly and do not invent citations or facts.`
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

module.exports = {
  getChatModel,
  getEmbeddingModel,
  normalizeIncomingMessages,
  toLangChainMessages,
  getTextFromContent,
}
