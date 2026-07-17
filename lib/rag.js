import { sequelize } from "../db/client.js";
import { generateEmbedding } from "../utils/generateEmbedding.js";

// FIX — with no timeout, a hang in the embedding call or the DB query used
// to block the guest's entire turn indefinitely, since nothing in
// chatbot.service.js wraps this call in a try/catch either. This makes a
// stuck lookup fail fast — the caller already has a clean "I don't have
// information regarding that" path for an empty result, so this keeps
// response time fast rather than risking a multi-minute stall.
const RAG_TIMEOUT_MS = 10000;

export async function searchSimilarChunks({
  query,
  chatbotId,
  propertyId,
  topK = 5,
}) {
  const startedAt = Date.now();

  try {
    const results = await withTimeout(
      runSearch({ query, chatbotId, propertyId, topK }),
      RAG_TIMEOUT_MS,
    );

    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[rag] OK query="${query}" propertyId=${propertyId || "none"} elapsedMs=${elapsedMs} chunks=${results.length} distances=[${results.map((r) => r.distance.toFixed(3)).join(",")}]`,
    );

    return results;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    // FIX — this used to throw uncaught, and nothing in chatbot.service.js
    // wraps searchSimilarChunks — any embedding or DB failure crashed the
    // guest's ENTIRE turn with no reply at all. Returning [] instead lets
    // the caller's existing "no information found" path handle it
    // gracefully, with no change to the success path.
    console.error(
      `[rag] FAILED query="${query}" propertyId=${propertyId || "none"} elapsedMs=${elapsedMs} error=${err.message}`,
    );
    return [];
  }
}

async function runSearch({ query, chatbotId, propertyId, topK }) {
  const embedStart = Date.now();
  const queryEmbedding = await generateEmbedding(query);
  const embedMs = Date.now() - embedStart;

  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  const dbStart = Date.now();
  const [results] = await sequelize.query(
    `
      SELECT
        c."chunkId",
        c.content,
        c.metadata,
        c."documentId",
        d."fileName",
        d."propertyId",
        (c.embedding <=> $1::vector) AS distance
      FROM chunks c
      INNER JOIN documents d ON d."documentId" = c."documentId"
      WHERE
        d."chatbotId" = $2
        AND d.status = 'completed'
        ${propertyId ? `AND d."propertyId" = $3` : ""}
      ORDER BY c.embedding <=> $1::vector
      LIMIT ${propertyId ? "$4" : "$3"}
      `,
    {
      bind: propertyId
        ? [vectorLiteral, chatbotId, propertyId, topK]
        : [vectorLiteral, chatbotId, topK],
    },
  );
  const dbMs = Date.now() - dbStart;

  // Split timing so a slow turn is instantly diagnosable as "embedding API
  // is slow" vs "DB query is slow" instead of one opaque total.
  console.log(`[rag] timing embedMs=${embedMs} dbMs=${dbMs}`);

  return results;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`RAG lookup timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}