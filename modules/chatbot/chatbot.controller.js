import Chatbot from "../../models/chatbot.model.js";
import { chatbotService } from "./chatbot.service.js";

import cloudinary from '../../lib/cloudinary.js'
export async function getChatbotBySlug(req, res, next) {
  try {
    const { slug } = req.params;
    const chatbot = await Chatbot.findOne({
      where: { slug },
      attributes: ["chatbotId", "name", "slug", "theme", "logoUrl"],
    });
    if (!chatbot)
      return res.status(404).json({ message: "Chatbot not found." });
    res.status(200).json({ chatbot });
  } catch (err) {
    next(err);
  }
}

export async function uploadChatbotLogo(req, res, next) {
  try {
    const { chatbotId } = req.params;
    if (!req.file) return res.status(400).json({ message: "No file uploaded." });

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: `logos/${chatbotId}`,
          overwrite: true,
          transformation: [{ width: 128, height: 128, crop: "fill" }],
          format: "webp",
        },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    const [updated] = await Chatbot.update(
      { logoUrl: uploadResult.secure_url },
      { where: { chatbotId } }
    );
    if (!updated) return res.status(404).json({ message: "Chatbot not found." });

    res.status(200).json({ logoUrl: uploadResult.secure_url });
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

// Pure lookup for the "Book a Stay" modal destination dropdown — no session,
// no LLM involved.
export async function getProperties(req, res, next) {
  try {
    const { chatbotId } = req.query;

    console.log("chatbotId", chatbotId);
    const properties = await chatbotService.getProperties({ chatbotId });

    res.status(200).json({ properties });
  } catch (err) {
    next(err);
  }
}

// Bypasses the LLM entirely — called after the guest fills the modal form
// and taps "Search Offers".
export async function searchOffers(req, res, next) {
  try {
    const { sessionId, chatbotId, propertyId, arrival, departure, adults } =
      req.body;

    const reply = await chatbotService.searchOffers({
      sessionId,
      chatbotId,
      propertyId,
      arrival,
      departure,
      adults,
    });

    res.status(200).json({ reply });
  } catch (err) {
    next(err);
  }
}
