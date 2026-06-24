import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.js";
import { createPropertySchema, updatePropertySchema } from "./property.schema.js";
import {
  createProperty,
  getAllProperties,
  getPropertyById,
  updateProperty,
  deleteProperty,
} from "./property.controller.js";
import { isAuth } from "../../middleware/isAuth.js";

const router = Router();

// All property routes require login + admin role
router.use(isAuth);

// POST   /property          — create a new hotel property
router.post("/", validateRequest(createPropertySchema), createProperty);

// GET    /property          — list all properties
router.get("/", getAllProperties);

// GET    /property/:propertyId   — get single property
router.get("/:propertyId", getPropertyById);

// PUT    /property/:propertyId   — update property details
router.put("/:propertyId", validateRequest(updatePropertySchema), updateProperty);

// DELETE /property/:propertyId   — delete property
router.delete("/:propertyId", deleteProperty);

export default router;