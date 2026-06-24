import { DataTypes } from "sequelize";
import { sequelize } from "../db/client.js";

const Chunk = sequelize.define("chunk", {
  chunkId: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },

  documentId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: "documents",
      key: "documentId",
    },
    onDelete: "CASCADE",
  },

  content: {
    type: DataTypes.TEXT,
    allowNull: false,
  },

  embedding: {
    type: DataTypes.VECTOR(384),
    allowNull: true
  },

  chunkIndex: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },

  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {}, // stores chunk size and chunk overlap
  },
});

export default Chunk;
