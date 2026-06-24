import { z } from "zod";

// Validated after Multer runs — req.body contains these fields.
// The file itself is validated by Multer's fileFilter (type + presence).
export const uploadDocumentSchema = z.object({
  chatbotId:    z.string().uuid({ message: "chatbotId must be a valid UUID." }),
  propertyId:   z.string().uuid({ message: "propertyId must be a valid UUID." }).optional(),
  chunkSize:    z.coerce.number().int().min(100).max(5000).default(1000),
  chunkOverlap: z.coerce.number().int().min(0).max(1000).default(200),
});

export const documentParamsSchema = z.object({
  documentId: z.string().uuid({ message: "documentId must be a valid UUID." }),
});

export const chatbotParamsSchema = z.object({
  chatbotId: z.string().uuid({ message: "chatbotId must be a valid UUID." }),
});