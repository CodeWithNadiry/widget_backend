import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.js";
import {
  createChatbotSchema,
  updateChatbotBodySchema,
  assignPropertySchema,
  chatbotIdParamsSchema,
  removePropertyParamsSchema,
} from "./admin.schema.js";
import {
  createChatbot,
  getAllChatbots,
  getChatbotById,
  deleteChatbot,
  assignProperty,
  removeProperty,
  getChatbotProperties,
  updateChatbot,
} from "./admin.controller.js";
import { isAuth } from "../../middleware/isAuth.js";

const router = Router();

// All admin routes require authentication
router.use(isAuth);

// POST /admin/chatbots
router.post(
  "/",
  validateRequest({
    body: createChatbotSchema,
  }),
  createChatbot
);

// GET /admin/chatbots
router.get("/", getAllChatbots);

// GET /admin/chatbots/:chatbotId
router.get(
  "/:chatbotId",
  validateRequest({
    params: chatbotIdParamsSchema,
  }),
  getChatbotById
);

// PUT /admin/chatbots/:chatbotId
router.put(
  "/:chatbotId",
  validateRequest({
    params: chatbotIdParamsSchema,
    body: updateChatbotBodySchema,
  }),
  updateChatbot
);

// DELETE /admin/chatbots/:chatbotId
router.delete(
  "/:chatbotId",
  validateRequest({
    params: chatbotIdParamsSchema,
  }),
  deleteChatbot
);

// POST /admin/chatbots/:chatbotId/properties
router.post(
  "/:chatbotId/properties",
  validateRequest({
    params: chatbotIdParamsSchema,
    body: assignPropertySchema,
  }),
  assignProperty
);

// DELETE /admin/chatbots/:chatbotId/properties/:propertyId
router.delete(
  "/:chatbotId/properties/:propertyId",
  validateRequest({
    params: removePropertyParamsSchema,
  }),
  removeProperty
);

// GET /admin/chatbots/:chatbotId/properties
router.get(
  "/:chatbotId/properties",
  validateRequest({
    params: chatbotIdParamsSchema,
  }),
  getChatbotProperties
);

export default router;