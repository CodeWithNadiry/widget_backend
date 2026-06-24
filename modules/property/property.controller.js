import { propertyService } from "./property.service.js";

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
