import { DataTypes } from "sequelize";
import { sequelize } from "../db/client.js";

const Chatbot = sequelize.define('chatbot', {
  chatbotId: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },

  slug: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,           // "crito", "partner-hotels" — must be unique
    validate: {
      is: /^[a-z0-9-]+$/i  // only lowercase letters, numbers, hyphens
    }
  },

  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },

  systemPrompt: {
    type: DataTypes.TEXT,
    allowNull: false,
  },

  createdBy: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'userId' },
    onDelete: 'CASCADE',
  },
});

export default Chatbot;