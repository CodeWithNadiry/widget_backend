import { sequelize } from "../db/client.js";
import { generateEmbedding } from "../utils/generateEmbedding.js";

export async function searchSimilarChunks({
  query,
  chatbotId,
  propertyId,
  topK = 5,
}) {
  const queryEmbedding = await generateEmbedding(query);
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

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

  // ── TEMPORARY DEBUG LOG — remove once the RAG miss is diagnosed. ──────────
  // Shows the actual distance score and a content preview for every chunk
  // retrieved for this query, so we can see whether the right chunk came back
  // with a distance ABOVE your current thresholds (= calibration problem) or
  // didn't come back at all / only partially (= chunking problem).
  console.log(
    `[RAG DEBUG] query="${query}"`,
    results.map((r) => ({ distance: r.distance, preview: r.content.slice(0, 80) })),
  );

  return results;
}