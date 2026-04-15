import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';

const PINECONE_CONTROL_PLANE_URL = 'https://api.pinecone.io';
const PINECONE_API_VERSION = '2025-10';

type PineconeDescribeIndexResponse = {
  dimension?: number;
  host?: string;
  status?: {
    ready?: boolean;
    state?: string;
  };
};

function readRequiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} must be set.`);
  }

  return value;
}

function readOptionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readOptionalPositiveInteger(name: string) {
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

function inferDimensions(model: string) {
  if (model === 'text-embedding-3-small') {
    return 1536;
  }

  if (model === 'text-embedding-3-large') {
    return 3072;
  }

  return null;
}

async function readErrorMessage(response: Response) {
  const text = await response.text();
  return text ? `${response.status} ${response.statusText}: ${text}` : `${response.status} ${response.statusText}`;
}

const pineconeApiKey = readRequiredEnv('PINECONE_API_KEY');
const indexName = readRequiredEnv('PINECONE_INDEX_NAME');
const cloud = readOptionalEnv('PINECONE_CLOUD') ?? 'aws';
const region = readOptionalEnv('PINECONE_REGION') ?? 'us-east-1';
const metric = readOptionalEnv('PINECONE_METRIC') ?? 'cosine';
const embeddingModel = readOptionalEnv('OPENAI_EMBEDDING_MODEL') ?? 'text-embedding-3-small';
const dimension =
  readOptionalPositiveInteger('OPENAI_EMBEDDING_DIMENSIONS') ?? inferDimensions(embeddingModel);

if (!dimension) {
  throw new Error(
    'Unable to determine index dimensions. Set OPENAI_EMBEDDING_DIMENSIONS explicitly for this embedding model.',
  );
}

function buildHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Api-Key': pineconeApiKey,
    'X-Pinecone-Api-Version': PINECONE_API_VERSION,
  };
}

async function describeIndex() {
  const response = await fetch(
    `${PINECONE_CONTROL_PLANE_URL}/indexes/${encodeURIComponent(indexName)}`,
    {
      headers: buildHeaders(),
    },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Pinecone describe index failed with ${await readErrorMessage(response)}`);
  }

  return (await response.json()) as PineconeDescribeIndexResponse;
}

async function createIndex() {
  const response = await fetch(`${PINECONE_CONTROL_PLANE_URL}/indexes`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({
      name: indexName,
      dimension,
      metric,
      spec: {
        serverless: {
          cloud,
          region,
        },
      },
      deletion_protection: 'disabled',
      tags: {
        project: 'agent-playground',
        source: 'postgres-notes',
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Pinecone create index failed with ${await readErrorMessage(response)}`);
  }
}

async function waitForReadyIndex() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const index = await describeIndex();

    if (!index) {
      throw new Error(`Pinecone index "${indexName}" was not found after creation.`);
    }

    if (index.dimension !== dimension) {
      throw new Error(
        `Pinecone index "${indexName}" has dimension ${index.dimension}, but the embedding config expects ${dimension}.`,
      );
    }

    if (index.status?.ready && index.host) {
      return index;
    }

    await delay(1500);
  }

  throw new Error(`Pinecone index "${indexName}" did not become ready in time.`);
}

const existingIndex = await describeIndex();

if (!existingIndex) {
  await createIndex();
}

const readyIndex = await waitForReadyIndex();

console.log(`Pinecone index "${indexName}" is ready.`);
console.log(`PINECONE_INDEX_HOST=${readyIndex.host}`);
console.log(`Embedding model: ${embeddingModel}`);
console.log(`Embedding dimensions: ${dimension}`);
