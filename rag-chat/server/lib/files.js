const crypto = require('crypto')
const { Pool } = require('pg')
const { hasPostgresConfig } = require('./config')
const { createHttpError } = require('./http')

let postgresPool = null
let filesTableReadyPromise = null

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

module.exports = {
  getPostgresPool,
  ensureFilesTable,
  saveFileRecord,
  listFileRecords,
  getFileRecordById,
  markFileProcessingStarted,
  markFileProcessingCompleted,
  markFileProcessingFailed,
}
