import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export function splitText(text, chunkSize = 1000, chunkOverlap = 200) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
  });

  return splitter.splitText(text);
}