import { pipeline } from "@xenova/transformers";

let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline(
      "feature-extraction", // Convert text → vector embeddings
      "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      // "Xenova/all-MiniLM-L6-v2",
    );
  }
  return embedder;
}

export async function generateEmbedding(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: "mean", normalize: true });

  // Explicitly free tensor memory after each use
  const embedding = Array.from(output.data).map(Number);
  output.dispose?.(); // release ONNX tensor from memory
  
  return embedding;
}