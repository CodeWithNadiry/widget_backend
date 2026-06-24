import { DataTypes } from "sequelize";
import { sequelize } from "../db/client.js";

const Document = sequelize.define("document", {
  documentId: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },

  chatbotId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: "chatbots",
      key: "chatbotId",
    },
    onDelete: "CASCADE",
  },

  propertyId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: "properties",
      key: "propertyId",
    },
    onDelete: "CASCADE",
  },

  fileName: { 
    type: DataTypes.STRING, 
    allowNull: false 
  },

  filePath: { 
    type: DataTypes.TEXT, 
    allowNull: false 
  },

  fileType: { 
    type: DataTypes.STRING 
  },

  status: {
    type: DataTypes.ENUM("pending", "processing", "completed", "failed"),
    defaultValue: "pending",
  },
});

export default Document;