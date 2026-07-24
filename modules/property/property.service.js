import Property from "../../models/property.model.js";
import ChatbotProperties from "../../models/chatbotProperties.model.js";
import { AppError, NotFoundError } from "../../utils/AppError.js";

export const propertyService = {
  async createProperty({ apaleoCode, name, address, apiKey, userId }) {
    // apaleoCode must be unique per user — two users could have
    // different properties with the same Apaleo code, but one user
    // cannot register the same property twice
    const existing = await Property.findOne({
      where: { apaleoCode, createdBy: userId },
    });

    if (existing) {
      throw new AppError(
        "A property with this Apaleo code already exists.",
        409,
      );
    }

    const property = await Property.create({
      apaleoCode,
      name,
      address,
      apiKey: apiKey ?? null,
      createdBy: userId,
    });

    return property;
  },

  async getAllProperties(userId) {
    const properties = await Property.findAll({
      where: { createdBy: userId },
      order: [["createdAt", "DESC"]],
    });

    return properties;
  },

  async getPropertyById({ propertyId, userId }) {
    const property = await Property.findOne({
      where: { propertyId, createdBy: userId },
    });

    if (!property) {
      throw new NotFoundError("Property not found.");
    }

    // Properties are enforced single-chatbot (see admin.service.js
    // assignProperty), so there's at most one row here. Looked up directly
    // against the join table rather than via a Sequelize association, so
    // this doesn't depend on an association/alias being set up correctly.
    const assignment = await ChatbotProperties.findOne({
      where: { propertyId },
    });

    return {
      ...property.toJSON(),
      chatbotId: assignment?.chatbotId ?? null,
    };
  },

  async updateProperty({ propertyId, userId, updates }) {
    const property = await Property.findOne({
      where: { propertyId, createdBy: userId },
    });

    if (!property) {
      throw new NotFoundError("Property not found.");
    }

    // if apaleoCode is being changed, check it won't collide
    if (updates.apaleoCode && updates.apaleoCode !== property.apaleoCode) {
      const collision = await Property.findOne({ //The collision check asks: "Does another property already have this new apaleoCode?" 
        where: { apaleoCode: updates.apaleoCode, createdBy: userId },
      });

      if (collision) {
        throw new AppError(
          "A property with this Apaleo code already exists.",
          409,
        );
      }
    }

    await property.update(updates);

    return property;
  },

  async deleteProperty({ propertyId, userId }) {
    const property = await Property.findOne({
      where: { propertyId, createdBy: userId },
    });

    if (!property) {
      throw new NotFoundError("Property not found.");
    }

    // Deleting a property is a full delete — clear any chatbot
    // assignment(s) first instead of blocking on them.
    await ChatbotProperties.destroy({ where: { propertyId } });

    await property.destroy();
  },
};