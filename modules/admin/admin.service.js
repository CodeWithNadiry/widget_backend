import Chatbot from "../../models/chatbot.model.js";
import Property from "../../models/property.model.js";
import ChatbotProperties from "../../models/chatbotProperties.model.js";
import { AppError, NotFoundError } from "../../utils/AppError.js";

export const adminService = {
  // ─── Chatbot CRUD ────────────────────────────────────────────────────────

  async createChatbot({ name, slug, systemPrompt, theme, userId }) {
    const existing = await Chatbot.findOne({ where: { slug } });
    if (existing) {
      throw new AppError("A chatbot with this slug already exists.", 409);
    }

    const chatbot = await Chatbot.create({
      name,
      slug,
      systemPrompt,
      theme: theme ?? {},   // ✅ save theme
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
      attributes: ["chatbotId", "name", "slug", "systemPrompt", "theme"],
    });
    if (!chatbot) throw new NotFoundError("Chatbot not found.");
    return chatbot;
  },

  async updateChatbot(chatbotId, data) {
    const chatbot = await Chatbot.findByPk(chatbotId);
    if (!chatbot) throw new NotFoundError("Chatbot not found.");

    // Only pass fields that were actually sent
    const updates = {};
    if (data.name !== undefined)         updates.name = data.name;
    if (data.systemPrompt !== undefined) updates.systemPrompt = data.systemPrompt;
    if (data.theme !== undefined)        updates.theme = data.theme;  // ✅ save theme

    await chatbot.update(updates);

    return {
      chatbot: {
        chatbotId: chatbot.chatbotId,
        name: chatbot.name,
        slug: chatbot.slug,
        systemPrompt: chatbot.systemPrompt,
        theme: chatbot.theme,  // ✅ return theme
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
    const chatbot = await Chatbot.findOne({
      where: { chatbotId, createdBy: userId },
    });

    if (!chatbot) {
      throw new NotFoundError("Chatbot not found.");
    }

    const property = await Property.findOne({
      where: { propertyId, createdBy: userId },
    });

    if (!property) {
      throw new NotFoundError("Property not found.");
    }

    const alreadyAssigned = await ChatbotProperties.findOne({
      where: { chatbotId, propertyId },
    });

    if (alreadyAssigned) {
      throw new AppError("This property is already assigned to the chatbot.", 409);
    }

    await ChatbotProperties.create({ chatbotId, propertyId });
  },

  async removeProperty({ chatbotId, propertyId, userId }) {
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
    });

    if (!chatbot) {
      throw new NotFoundError("Chatbot not found.");
    }

    return {
      properties: chatbot.properties ?? [],
    };
  },
};