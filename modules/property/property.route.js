import { Router } from "express";
import multer from "multer";
import { validateRequest } from "../../middleware/validateRequest.js";
import { createPropertySchema, updatePropertySchema } from "./property.schema.js";
import {
  createProperty,
  getAllProperties,
  getPropertyById,
  updateProperty,
  deleteProperty,
  uploadPropertyImage,
} from "./property.controller.js";
import { isAuth } from "../../middleware/isAuth.js";

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

// POST   /property/:propertyId/image — upload/replace the property photo
router.post("/:propertyId/image", upload.single("image"), uploadPropertyImage);

// DELETE /property/:propertyId   — delete property
router.delete("/:propertyId", deleteProperty);

export default router;