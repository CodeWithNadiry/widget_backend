import { z } from "zod";

// ---------- Body Schemas ----------
const themeSchema = z.object({
  primaryColor: z.string().optional(),
  headerBg: z.string().optional(),
  aiBubbleBg: z.string().optional(),
}).optional();

export const createChatbotSchema = z.object({
  name: z.string().min(1, "Name is required"),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  systemPrompt: z.string().min(1),
  theme: themeSchema,        // ✅ add this
});

export const updateChatbotBodySchema = z.object({
  name: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  theme: themeSchema,        // ✅ add this
});


export const assignPropertySchema = z.object({
  propertyId: z.string().uuid("propertyId must be a valid UUID"),
});

// ---------- Params Schemas ----------

export const chatbotIdParamsSchema = z.object({
  chatbotId: z.string().uuid("chatbotId must be a valid UUID"),
});

export const removePropertyParamsSchema = z.object({
  chatbotId: z.string().uuid("chatbotId must be a valid UUID"),
  propertyId: z.string().uuid("propertyId must be a valid UUID"),
});