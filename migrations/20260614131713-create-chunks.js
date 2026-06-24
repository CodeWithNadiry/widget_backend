export async function up(queryInterface) {
  await queryInterface.sequelize.query(
    "CREATE EXTENSION IF NOT EXISTS vector;"
  );

  await queryInterface.sequelize.query(`
    CREATE TABLE chunks (
      "chunkId"    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "documentId" UUID NOT NULL REFERENCES documents("documentId") ON DELETE CASCADE,
      content      TEXT NOT NULL,
      embedding    vector(384),
      "chunkIndex" INTEGER NOT NULL,
      metadata     JSONB DEFAULT '{}'::jsonb,
      "createdAt"  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // HNSW index for cosine similarity search
  await queryInterface.sequelize.query(`
    CREATE INDEX chunk_embedding_idx
    ON chunks
    USING hnsw (embedding vector_cosine_ops);
  `);

  // documentId index for JOIN performance in RAG queries
  await queryInterface.sequelize.query(`
    CREATE INDEX chunks_document_idx
    ON chunks ("documentId");
  `);
}

export async function down(queryInterface) {
  await queryInterface.sequelize.query(
    "DROP INDEX IF EXISTS chunk_embedding_idx;"
  );
  await queryInterface.sequelize.query(
    "DROP INDEX IF EXISTS chunks_document_idx;"
  );
  await queryInterface.dropTable("chunks");
}