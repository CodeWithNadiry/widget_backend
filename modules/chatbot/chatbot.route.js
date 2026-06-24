import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.js";
import { verifyInternalKey } from "../../middleware/verifyInternalKey.js";
import { chatMessageSchema } from "./chatbot.schema.js";
import { getChatbotBySlug, handleMessage } from "./chatbot.controller.js";

const router = Router();

router.get("/:slug", getChatbotBySlug); // public, no verifyInternalKey

//chatbot/message
router.post(
  "/message",
  verifyInternalKey,
  validateRequest(chatMessageSchema),
  handleMessage,
);

export default router;
