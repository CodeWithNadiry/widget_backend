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
        : [vectorLiteral, chatbotId, topK], // Returns the 5 most semantically similar text chunks
    },
  );

  return results;
}
