import { z } from "zod";

export const createPropertySchema = z.object({
  apaleoCode: z.string().min(1, "Apaleo code is required"),
  name: z.string().min(1, "Name is required"),
  address: z.string().min(1, "Address is required"),
  apiKey: z.string().optional(),
});

export const updatePropertySchema = z.object({
  apaleoCode: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
  apiKey: z.string().optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: "At least one field must be provided to update." }
);