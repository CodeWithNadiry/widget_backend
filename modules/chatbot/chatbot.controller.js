import Chatbot from "../../models/chatbot.model.js";
import { chatbotService } from "./chatbot.service.js";

export async function getChatbotBySlug(req, res, next) {
  try {
    const { slug } = req.params;
    console.log('slug', slug)
    const chatbot = await Chatbot.findOne({
      where: { slug },
      attributes: ["chatbotId", "name", "slug", "theme"],
    });
    if (!chatbot)
      return res.status(404).json({ message: "Chatbot not found." });
    res.status(200).json({ chatbot });
  } catch (err) {
    next(err);
  }
}

export async function handleMessage(req, res, next) {
  try {
    const { sessionId, chatbotId, message } = req.body;

    const reply = await chatbotService.handleMessage({
      sessionId,
      chatbotId,
      message,
    });

    res.status(200).json({ reply });
  } catch (err) {
    next(err);
  }
}
