import z from "zod";

export const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(6),
});

export const loginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(6),
});