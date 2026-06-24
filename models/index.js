import User from "./user.model.js";
import Chatbot from "./chatbot.model.js";
import Property from "./property.model.js";
import ChatbotProperties from "./chatbotProperties.model.js";
import Document from "./document.model.js";
import Chunk from "./chunk.model.js";

export const initModels = () => {
  // Admin creates chatbots
  User.hasMany(Chatbot, { foreignKey: "createdBy" });
  Chatbot.belongsTo(User, { foreignKey: "createdBy" });

  // Admin creates properties
  User.hasMany(Property, { foreignKey: "createdBy" });
  Property.belongsTo(User, { foreignKey: "createdBy" });

  // Chatbot ↔ Property (many to many)
  Chatbot.belongsToMany(Property, {
    through: ChatbotProperties,
    foreignKey: "chatbotId",
  });
  Property.belongsToMany(Chatbot, {
    through: ChatbotProperties,
    foreignKey: "propertyId",
  });

  // Document → Chatbot & Property
  Chatbot.hasMany(Document, { foreignKey: "chatbotId" });
  Document.belongsTo(Chatbot, { foreignKey: "chatbotId" });

  Property.hasMany(Document, { foreignKey: "propertyId" });
  Document.belongsTo(Property, { foreignKey: "propertyId" });

  // Document → Chunks
  Document.hasMany(Chunk, { foreignKey: "documentId" });
  Chunk.belongsTo(Document, { foreignKey: "documentId" });
};
