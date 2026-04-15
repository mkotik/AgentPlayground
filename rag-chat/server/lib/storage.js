const crypto = require('crypto')
const { GetObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const { DEFAULT_UPLOAD_PREFIX } = require('./config')
const { createHttpError } = require('./http')

let storageClient = null

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

module.exports = {
  hasUploadConfig,
  getRequiredUploadConfig,
  getStorageClient,
  isPdfUpload,
  createPresignedUpload,
  downloadFileBuffer,
}
