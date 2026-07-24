import { z } from "zod";

export const createUserSchema = z.object({
  name: z.string().min(1, "Name is required."),
  email: z.string().email("Must be a valid email."),
  password: z.string().min(6, "Password must be at least 6 characters."),
  isActive: z.boolean().optional(),
});

export const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email("Must be a valid email.").optional(),
  isActive: z.boolean().optional(),
});