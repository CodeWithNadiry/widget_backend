import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.js";
import { verifyInternalKey } from "../../middleware/verifyInternalKey.js";
import multer from "multer";

import {
  chatMessageSchema,
  searchOffersSchema,
  getPropertiesSchema,
} from "./chatbot.schema.js";
import {
  getChatbotBySlug,
  handleMessage,
  getProperties,
  uploadChatbotLogo,
  searchOffers,
} from "./chatbot.controller.js";

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

//chatbot/message
router.post(
  "/message",
  verifyInternalKey,
  validateRequest(chatMessageSchema),
  handleMessage,
);

// chatbot/properties?chatbotId=xxx — pure lookup for the "Book a Stay" modal dropdown
router.get(
  "/properties",
  verifyInternalKey,
  validateRequest({ query: getPropertiesSchema }),
  getProperties,
);

// chatbot/search-offers — bypasses the LLM entirely, called after the guest
// fills the modal form and taps "Search Hotels"
router.post(
  "/search-offers",
  verifyInternalKey,
  validateRequest(searchOffersSchema),
  searchOffers,
);



router.get("/:slug", getChatbotBySlug);

router.post("/:chatbotId/logo", upload.single("logo"), uploadChatbotLogo);

export default router; // public, no verifyInternalKey

