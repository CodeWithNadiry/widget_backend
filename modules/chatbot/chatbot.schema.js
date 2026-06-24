import z from "zod";

export const chatMessageSchema = z.object({
  sessionId: z.string().min(1),
  chatbotId: z.string().min(1),
  message: z.string(), // ← removed .min(1) — allows empty string for greeting
});