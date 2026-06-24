import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.js";
import {
  uploadDocumentSchema,
  documentParamsSchema,
  chatbotParamsSchema,
} from "./document.schema.js";
import {
  uploadDocuments,
  getDocumentsByChatbot,
  deleteDocument,
} from "./document.controller.js";
import { isAuth } from "../../middleware/isAuth.js";
import { upload } from "../../middleware/upload.js";

const router = Router();

router.use(isAuth);

// POST /document/upload
router.post(
  "/upload",
  upload.array("files"),
  validateRequest(uploadDocumentSchema),
  uploadDocuments
);

// GET /document/:chatbotId
router.get(
  "/:chatbotId",
  validateRequest({ params: chatbotParamsSchema }),
  getDocumentsByChatbot
);

// DELETE /document/:documentId
router.delete(
  "/:documentId",
  validateRequest({ params: documentParamsSchema }),
  deleteDocument
);

export default router;