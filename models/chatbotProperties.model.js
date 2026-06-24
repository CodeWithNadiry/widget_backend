// backend/src/models/ChatbotProperties.js

import { DataTypes } from "sequelize";
import { sequelize } from "../db/client.js";

const ChatbotProperties = sequelize.define('chatbotProperties', {
  chatbotPropertiesId: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true 
  },

  chatbotId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'chatbots',
      key: 'chatbotId'
    },
    onDelete: 'CASCADE'  // if chatbot deleted → remove links
  },

  propertyId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'properties',
      key: 'propertyId'
    },
    onDelete: 'CASCADE'  // if property deleted → remove links
  }
});

export default ChatbotProperties;