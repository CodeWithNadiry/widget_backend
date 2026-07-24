// backend/src/models/Property.js

import { DataTypes } from "sequelize";
import { sequelize } from "../db/client.js";

const Property = sequelize.define('property', {
  propertyId: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },

  apaleoCode: {
    type: DataTypes.STRING,
    allowNull: false 
  },

  name: {
    type: DataTypes.STRING,
    allowNull: false
  },

  address: {
    type: DataTypes.STRING,
    allowNull: false
  },

  apiKey: {
    type: DataTypes.STRING,
    allowNull: true   // encrypted, used for X-API-Key header
  },

  imageUrl: {
    type: DataTypes.STRING,
    allowNull: true,
    validate: { isUrl: { msg: "imageUrl must be a valid URL" } },
  },

  createdBy: {
  type: DataTypes.UUID,
  allowNull: false,
  references: {
    model: 'users',
    key: 'userId'
  },
  onDelete: 'CASCADE'
}

});

export default Property;