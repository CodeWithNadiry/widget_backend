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
    allowNull: false,
  },

  email: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false,
  },

  password: {
    type: DataTypes.STRING,
    allowNull: false,
  },

  role: {
    type: DataTypes.ENUM("admin", "user"),
    allowNull: false,
    defaultValue: "user",
  },

  // Admin-created users start inactive by default — the admin must
  // explicitly flip this on before that person can log in. The seeded
  // default admin is the one exception (set to true at bootstrap time,
  // bypassing this column default).
  isActive: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
});

export default User;