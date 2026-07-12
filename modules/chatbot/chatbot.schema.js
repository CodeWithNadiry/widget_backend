import z from "zod";

export const chatMessageSchema = z.object({
  sessionId: z.string().min(1),
  chatbotId: z.string().min(1),
  message: z.string(), // ← removed .min(1) — allows empty string for greeting
});

export const getPropertiesSchema = z.object({
  chatbotId: z.string().min(1),
});

export const searchOffersSchema = z.object({
  sessionId: z.string().min(1),
  chatbotId: z.string().min(1),
  propertyId: z.string().min(1),
  arrival: z.string().min(1), // YYYY-MM-DD, from the date picker
  departure: z.string().min(1), // YYYY-MM-DD, from the date picker
  adults: z.number().int().min(1).max(10),
});
