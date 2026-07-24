import { propertyService } from "./property.service.js";
import Property from "../../models/property.model.js";
import cloudinary from "../../lib/cloudinary.js";

export async function createProperty(req, res, next) {
  try {
    const { apaleoCode, name, address, apiKey } = req.body;
    const userId = req.userId;

    const property = await propertyService.createProperty({
      apaleoCode,
      name,
      address,
      apiKey,
      userId,
    });

    res.status(201).json({ property });
  } catch (err) {
    next(err);
  }
}

export async function getAllProperties(req, res, next) {
  try {
    const userId = req.userId;

    const properties = await propertyService.getAllProperties(userId);

    res.status(200).json({ properties });
  } catch (err) {
    next(err);
  }
}

export async function getPropertyById(req, res, next) {
  try {
    const { propertyId } = req.params;
    const userId = req.userId;

    const property = await propertyService.getPropertyById({
      propertyId,
      userId,
    });

    res.status(200).json({ property });
  } catch (err) {
    next(err);
  }
}

export async function updateProperty(req, res, next) {
  try {
    const { propertyId } = req.params;
    const userId = req.userId;
    const updates = req.body;

    const property = await propertyService.updateProperty({
      propertyId,
      userId,
      updates,
    });

    res.status(200).json({ property });
  } catch (err) {
    next(err);
  }
}

export async function deleteProperty(req, res, next) {
  try {
    const { propertyId } = req.params;
    const userId = req.userId;

    await propertyService.deleteProperty({ propertyId, userId });

    res.status(200).json({ message: "Property deleted successfully." });
  } catch (err) {
    next(err);
  }
}

export async function uploadPropertyImage(req, res, next) {
  try {
    const { propertyId } = req.params;
    const userId = req.userId;
    if (!req.file) return res.status(400).json({ message: "No file uploaded." });

    // Ownership check — isAuth only proves the request is authenticated,
    // not that this property belongs to this user.
    const property = await Property.findOne({ where: { propertyId, createdBy: userId } });
    if (!property) return res.status(404).json({ message: "Property not found." });

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: `properties/${propertyId}`,
          overwrite: true,
          // Wider crop than the chatbot logo — this renders as a full-width
          // banner image on the property card, not a small circular avatar.
          transformation: [{ width: 800, height: 450, crop: "fill" }],
          format: "webp",
        },
        (err, result) => (err ? reject(err) : resolve(result)),
      );
      stream.end(req.file.buffer);
    });

    await property.update({ imageUrl: uploadResult.secure_url });

    res.status(200).json({ imageUrl: uploadResult.secure_url });
  } catch (err) {
    next(err);
  }
}