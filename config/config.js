import {config} from "dotenv";
config()

export const configData = {
  databaseUrl: process.env.DATABASE_URL,
  jwtSecretKey: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN,
};