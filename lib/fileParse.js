import fs from "fs";
import mammoth from "mammoth";
import { extractText as extractPdfText } from "unpdf";

export async function extractText(file) {

  if (file.mimetype === "application/pdf") {
    const dataBuffer = await fs.promises.readFile(file.path);

    const { text } = await extractPdfText(
      new Uint8Array(dataBuffer)
    );

    return Array.isArray(text)
      ? text.join("\n")
      : text;
  }

  if (
    file.mimetype ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const { value } = await mammoth.extractRawText({
      path: file.path,
    });

    return value;
  }

  if (file.mimetype === "text/plain") {
    return await fs.promises.readFile(file.path, "utf8");
  }

  throw new Error("Unsupported file type");
}
