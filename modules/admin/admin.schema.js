import { z } from "zod";

// ---------- Body Schemas ----------

export const createChatbotSchema = z.object({
  name: z.string().min(1, "Name is required"),

  slug: z
    .string()
    .min(1, "Slug is required")
    .regex(
      /^[a-z0-9-]+$/,
      "Slug may only contain lowercase letters, numbers, and hyphens"
    ),

  systemPrompt: z.string().min(1, "System prompt is required"),
});

export const updateChatbotBodySchema = z.object({
  name: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
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