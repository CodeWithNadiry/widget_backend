import fs from "fs";
import Document from "../../models/document.model.js";
import { sequelize } from "../../db/client.js";
import { generateEmbedding } from "../../utils/generateEmbedding.js";
import { getFileType } from "../../utils/getFileType.js";
import { splitText } from "../../lib/textSplitter.js";
import { extractText } from "../../lib/fileParse.js";
import { NotFoundError, BadRequestError } from "../../utils/AppError.js";

export const documentService = {

  async uploadDocuments(req) {
    const files = req.files;
    const { chatbotId, propertyId, chunkSize, chunkOverlap } = req.body;

    if (!files || files.length === 0) {
      throw new BadRequestError("No files provided.");
    }

    // Create all document rows immediately, then ingest each one.
    // We await all ingestions here — the frontend shows "processing"
    // until this entire response comes back, then switches to "completed".
    const results = await Promise.all(
      files.map(async (file) => {
        const document = await Document.create({
          chatbotId,
          propertyId: propertyId || null,
          fileName:   file.originalname,
          filePath:   file.path,
          fileType:   getFileType(file.mimetype),
          status:     "pending",
        });

        await documentService._ingest(document, file, { chunkSize, chunkOverlap });

        return {
          documentId: document.documentId,
          fileName:   document.fileName,
          fileType:   document.fileType,
          status:     document.status,
        };
      })
    );

    return {
      message: `${files.length} file${files.length > 1 ? "s" : ""} uploaded successfully.`,
      documents: results,
    };
  },

  async _ingest(document, file, { chunkSize = 1000, chunkOverlap = 200 } = {}) {
    try {
      const text = await extractText(file);

      if (!text || text.trim().length === 0) {
        await document.update({ status: "failed" });
        return;
      }

      await document.update({ status: "processing" });

      const chunks = await splitText(text, Number(chunkSize), Number(chunkOverlap));

      // Sequential — avoids ONNX memory spikes from parallel tensor ops
      const embeddings = [];
      for (const chunk of chunks) {
        const embedding = await generateEmbedding(chunk);
        embeddings.push(embedding);
      }

      // Raw SQL required — Sequelize can't serialize JS arrays into
      // pgvector literals natively
      await Promise.all(
        chunks.map((chunk, index) =>
          sequelize.query(
            `
            INSERT INTO chunks
              ("documentId", "chunkIndex", content, embedding, metadata)
            VALUES
              ($1, $2, $3, $4::vector, $5)
            `,
            {
              bind: [
                document.documentId,
                index,
                chunk,
                `[${embeddings[index].join(",")}]`,
                JSON.stringify({
                  chunkSize:    Number(chunkSize),
                  chunkOverlap: Number(chunkOverlap),
                }),
              ],
            }
          )
        )
      );

      await document.update({ status: "completed" });

    } catch (err) {
      await document.update({ status: "failed" });
      throw err;
    } finally {
      fs.unlink(file.path, (unlinkErr) => {
        if (unlinkErr) console.warn(`[cleanup] Could not delete file: ${file.path}`);
      });
    }
  },

  async getDocumentsByChatbot(chatbotId) {
    const documents = await Document.findAll({
      where: { chatbotId },
      order: [["createdAt", "DESC"]],
      attributes: [
        "documentId",
        "chatbotId",
        "propertyId",
        "fileName",
        "fileType",
        "status",
        "createdAt",
      ],
    });

    return { documents };
  },

  async deleteDocument(documentId) {
  const document = await Document.findByPk(documentId);

  if (!document) {
    throw new NotFoundError("Document not found.");
  }

  await document.destroy();

  if (document.filePath) {
    fs.access(document.filePath, fs.constants.F_OK, (err) => {
      if (!err) {
        // file exists, delete it
        fs.unlink(document.filePath, (unlinkErr) => {
          if (unlinkErr) console.warn(`[cleanup] Could not delete file: ${document.filePath}`);
        });
      }
      // file already gone — silently ignore
    });
  }

  return { message: "Document deleted successfully." };
},

};