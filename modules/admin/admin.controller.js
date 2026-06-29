import { adminService } from "./admin.service.js";

export async function createChatbot(req, res, next) {
  try {
    const { name, slug, systemPrompt, theme } = req.body; // ✅ already there
    const userId = req.userId;

    const chatbot = await adminService.createChatbot({
      name, slug, systemPrompt, theme, userId, // ✅ pass theme
    });

    res.status(201).json({ chatbot });
  } catch (err) {
    next(err);
  }
}
export async function getAllChatbots(req, res, next) {
  try {
    const userId = req.userId;

    const chatbots = await adminService.getAllChatbots(userId);

    res.status(200).json({ chatbots });
  } catch (err) {
    next(err);
  }
}

export async function getChatbotById(req, res, next) {
  try {
    const { chatbotId } = req.params;
    const userId = req.userId;

    const chatbot = await adminService.getChatbotById({ chatbotId, userId });

    res.status(200).json({ chatbot });
  } catch (err) {
    next(err);
  }
}


export async function updateChatbot(req, res, next) {
  try {
    const { chatbotId } = req.params;
    console.log("updateChatbot hit", chatbotId, req.body);
    const result = await adminService.updateChatbot(chatbotId, req.body);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteChatbot(req, res, next) {
  try {
    const { chatbotId } = req.params;
    const userId = req.userId;

    await adminService.deleteChatbot({ chatbotId, userId });

    res.status(200).json({ message: "Chatbot deleted successfully." });
  } catch (err) {
    next(err);
  }
}

export async function assignProperty(req, res, next) {
  try {
    const { chatbotId } = req.params;
    const { propertyId } = req.body;
    const userId = req.userId;

    await adminService.assignProperty({ chatbotId, propertyId, userId });

    res.status(201).json({ message: "Property assigned successfully." });
  } catch (err) {
    next(err);
  }
}

export async function removeProperty(req, res, next) {
  try {
    const { chatbotId, propertyId } = req.params;
    const userId = req.userId;

    await adminService.removeProperty({ chatbotId, propertyId, userId });

    res.status(200).json({ message: "Property removed successfully." });
  } catch (err) {
    next(err);
  }
}

export async function getChatbotProperties(req, res, next) {
  try {
    const { chatbotId } = req.params;
    const userId = req.userId;

    const result = await adminService.getChatbotProperties({ chatbotId, userId });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
