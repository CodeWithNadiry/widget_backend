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
    unique: true,
    validate: {
      is: /^[a-z0-9-]+$/i
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

  // ── Theme ──────────────────────────────────────────────────────────────
  // Change these per chatbot from your admin dashboard or directly in DB.
  // primaryColor : float button, user message bubble, send button
  // headerBg     : top bar background + AI avatar
  // aiBubbleBg   : AI message bubble background
  theme: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: {
      primaryColor: "#2563eb",
      headerBg:     "#0f172a",
      aiBubbleBg:   "#ffffff",
    },
  },

  createdBy: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'userId' },
    onDelete: 'CASCADE',
  },
});

export default Chatbot;