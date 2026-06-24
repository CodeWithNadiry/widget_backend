import Chatbot from "../../models/chatbot.model.js";
import Property from "../../models/property.model.js";
import ChatbotProperties from "../../models/chatbotProperties.model.js";
import { AppError, NotFoundError } from "../../utils/AppError.js";

export const adminService = {
  // ─── Chatbot CRUD ────────────────────────────────────────────────────────

  async createChatbot({ name, slug, systemPrompt, userId }) {
    // check slug is not already taken
    const existing = await Chatbot.findOne({ where: { slug } });
    if (existing) {
      throw new AppError("A chatbot with this slug already exists.", 409);
    }

    const chatbot = await Chatbot.create({
      name,
      slug,
      systemPrompt,
      createdBy: userId,
    });

    return chatbot;
  },

  async getAllChatbots(userId) {
    const chatbots = await Chatbot.findAll({
      where: { createdBy: userId },
      order: [["createdAt", "DESC"]],
    });

    return chatbots;
  },

  async getChatbotById({ chatbotId, userId }) {
    const chatbot = await Chatbot.findOne({
      where: { chatbotId, createdBy: userId },
    });

    if (!chatbot) {
      throw new NotFoundError("Chatbot not found.");
    }

    return chatbot;
  },


  async updateChatbot(chatbotId, data) {
  const chatbot = await Chatbot.findByPk(chatbotId);

  if (!chatbot) {
    throw new NotFoundError("Chatbot not found.");
  }

  await chatbot.update(data);

  return {
    chatbot: {
      chatbotId: chatbot.chatbotId,
      name: chatbot.name,
      slug: chatbot.slug,
      systemPrompt: chatbot.systemPrompt,
    },
  };
},


  async deleteChatbot({ chatbotId, userId }) {
    const chatbot = await Chatbot.findOne({
      where: { chatbotId, createdBy: userId },
    });

    if (!chatbot) {
      throw new NotFoundError("Chatbot not found.");
    }

    await chatbot.destroy();
  },

  // ─── Property assignment ─────────────────────────────────────────────────

  async assignProperty({ chatbotId, propertyId, userId }) {
    // verify chatbot belongs to this user
    const chatbot = await Chatbot.findOne({
      where: { chatbotId, createdBy: userId },
    });

    if (!chatbot) {
      throw new NotFoundError("Chatbot not found.");
    }

    // verify property belongs to this user
    const property = await Property.findOne({
      where: { propertyId, createdBy: userId },
    });

    if (!property) {
      throw new NotFoundError("Property not found.");
    }

    // check if already assigned
    const alreadyAssigned = await ChatbotProperties.findOne({
      where: { chatbotId, propertyId },
    });


    if (alreadyAssigned) {
      throw new AppError("This property is already assigned to the chatbot.", 409);
    }

    await ChatbotProperties.create({ chatbotId, propertyId });
  },

  async removeProperty({ chatbotId, propertyId, userId }) {
    // verify chatbot belongs to this user
    const chatbot = await Chatbot.findOne({
      where: { chatbotId, createdBy: userId },
    });

    if (!chatbot) {
      throw new NotFoundError("Chatbot not found.");
    }

    const assignment = await ChatbotProperties.findOne({
      where: { chatbotId, propertyId },
    });

    if (!assignment) {
      throw new NotFoundError("This property is not assigned to the chatbot.");
    }

    await assignment.destroy();
  },

async getChatbotProperties({ chatbotId, userId }) {
  const chatbot = await Chatbot.findOne({
    where: { chatbotId, createdBy: userId },
    include: [
      {
        model: Property,
        through: { attributes: [] },
      },
    ],
  }); // i want the chatbot and also related Property records

  if (!chatbot) {
    throw new NotFoundError("Chatbot not found.");
  }

  return {
    properties: chatbot.properties ?? [],  // ← lowercase 'properties'
  };
},
};