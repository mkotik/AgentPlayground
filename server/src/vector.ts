import 'dotenv/config';
import type { NoteRecord } from './db.js';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const PINECONE_CONTROL_PLANE_URL = 'https://api.pinecone.io';
const PINECONE_API_VERSION = '2025-10';

type VectorSyncStatus = {
  enabled: boolean;
  indexName: string | null;
  indexHostConfigured: boolean;
  namespace: string | null;
  embeddingModel: string | null;
};

type PineconeDescribeIndexResponse = {
  dimension?: number;
  host?: string;
  status?: {
    ready?: boolean;
    state?: string;
  };
};

type OpenAiEmbeddingsResponse = {
  data?: Array<{
    embedding?: number[];
  }>;
};

function readOptionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readOptionalNumberEnv(name: string) {
  const value = readOptionalEnv(name);

  if (!value) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when set.`);
  }

  return parsed;
}

function normalizeIndexHost(value: string | null) {
  if (!value) {
    return null;
  }

  return value.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

const openAiApiKey = readOptionalEnv('OPENAI_API_KEY');
const pineconeApiKey = readOptionalEnv('PINECONE_API_KEY');
const pineconeIndexName = readOptionalEnv('PINECONE_INDEX_NAME');
const pineconeIndexHost = normalizeIndexHost(readOptionalEnv('PINECONE_INDEX_HOST'));
const pineconeNamespace = readOptionalEnv('PINECONE_NAMESPACE') ?? 'notes';
const embeddingModel = readOptionalEnv('OPENAI_EMBEDDING_MODEL') ?? 'text-embedding-3-small';
const embeddingDimensions = readOptionalNumberEnv('OPENAI_EMBEDDING_DIMENSIONS');

const vectorConfigValues = [
  openAiApiKey,
  pineconeApiKey,
  pineconeIndexName ?? pineconeIndexHost,
];

const hasAnyVectorConfig = vectorConfigValues.some(Boolean);
const isVectorSyncEnabled = vectorConfigValues.every(Boolean);

if (hasAnyVectorConfig && !isVectorSyncEnabled) {
  throw new Error(
    'Vector sync is partially configured. Set OPENAI_API_KEY, PINECONE_API_KEY, and either PINECONE_INDEX_HOST or PINECONE_INDEX_NAME.',
  );
}

let resolvedPineconeIndexHost = pineconeIndexHost;

function buildVectorId(noteId: number) {
  return `note:${noteId}`;
}

function buildPineconeHeaders() {
  if (!pineconeApiKey) {
    throw new Error('PINECONE_API_KEY must be set when vector sync is enabled.');
  }

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Api-Key': pineconeApiKey,
    'X-Pinecone-Api-Version': PINECONE_API_VERSION,
  };
}

async function readErrorMessage(response: Response) {
  const text = await response.text();
  return text ? `${response.status} ${response.statusText}: ${text}` : `${response.status} ${response.statusText}`;
}

async function createEmbedding(input: string) {
  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY must be set when vector sync is enabled.');
  }

  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: embeddingModel,
      input,
      encoding_format: 'float',
      ...(embeddingDimensions ? { dimensions: embeddingDimensions } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI embeddings request failed with ${await readErrorMessage(response)}`);
  }

  const payload = (await response.json()) as OpenAiEmbeddingsResponse;
  const embedding = payload.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('OpenAI embeddings response did not include a usable embedding.');
  }

  return embedding;
}

async function resolvePineconeIndexHost() {
  if (resolvedPineconeIndexHost) {
    return resolvedPineconeIndexHost;
  }

  if (!pineconeIndexName) {
    throw new Error('Set PINECONE_INDEX_HOST or PINECONE_INDEX_NAME to use Pinecone.');
  }

  const response = await fetch(
    `${PINECONE_CONTROL_PLANE_URL}/indexes/${encodeURIComponent(pineconeIndexName)}`,
    {
      headers: buildPineconeHeaders(),
    },
  );

  if (!response.ok) {
    throw new Error(`Pinecone describe index failed with ${await readErrorMessage(response)}`);
  }

  const payload = (await response.json()) as PineconeDescribeIndexResponse;

  if (payload.status?.ready === false) {
    throw new Error(
      `Pinecone index "${pineconeIndexName}" is not ready yet (${payload.status.state ?? 'unknown state'}).`,
    );
  }

  if (!payload.host) {
    throw new Error(`Pinecone index "${pineconeIndexName}" did not return a host.`);
  }

  resolvedPineconeIndexHost = payload.host;
  return resolvedPineconeIndexHost;
}

function buildNoteMetadata(note: NoteRecord) {
  return {
    noteId: note.id,
    content: note.content,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
    source: 'postgres-notes',
  };
}

export function getVectorSyncStatus(): VectorSyncStatus {
  return {
    enabled: isVectorSyncEnabled,
    indexName: pineconeIndexName,
    indexHostConfigured: Boolean(pineconeIndexHost),
    namespace: isVectorSyncEnabled ? pineconeNamespace : null,
    embeddingModel: isVectorSyncEnabled ? embeddingModel : null,
  };
}

export async function syncNoteToVectorStore(note: NoteRecord) {
  if (!isVectorSyncEnabled) {
    return;
  }

  const [indexHost, values] = await Promise.all([
    resolvePineconeIndexHost(),
    createEmbedding(note.content),
  ]);

  const response = await fetch(`https://${indexHost}/vectors/upsert`, {
    method: 'POST',
    headers: buildPineconeHeaders(),
    body: JSON.stringify({
      namespace: pineconeNamespace,
      vectors: [
        {
          id: buildVectorId(note.id),
          values,
          metadata: buildNoteMetadata(note),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Pinecone upsert failed with ${await readErrorMessage(response)}`);
  }
}

export async function deleteNoteFromVectorStore(noteId: number) {
  if (!isVectorSyncEnabled) {
    return;
  }

  const indexHost = await resolvePineconeIndexHost();
  const response = await fetch(`https://${indexHost}/vectors/delete`, {
    method: 'POST',
    headers: buildPineconeHeaders(),
    body: JSON.stringify({
      namespace: pineconeNamespace,
      ids: [buildVectorId(noteId)],
    }),
  });

  if (!response.ok) {
    throw new Error(`Pinecone delete failed with ${await readErrorMessage(response)}`);
  }
}
