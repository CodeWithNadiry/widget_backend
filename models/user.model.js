import { DataTypes } from "sequelize";
import { sequelize } from "../db/client.js";

const User = sequelize.define("user", {
  userId: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },

  name: { 
    type: DataTypes.STRING, 
    allowNull: false 
  },

  email: { 
    type: DataTypes.STRING, 
    unique: true, 
    allowNull: false 
  },

  password: { 
    type: DataTypes.STRING, 
    allowNull: false 
  },
});

export default User;