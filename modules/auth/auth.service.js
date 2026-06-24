import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../../models/user.model.js";
import { AppError, UnauthorizedError } from "../../utils/AppError.js";
import { configData } from "../../config/config.js";

const { jwtSecretKey, jwtExpiresIn } = configData;

export const authService = {
  async signupUser(data) {
    const { name, email, password } = data;

    const existingUser = await User.findOne({ where: { email } });

    if (existingUser) {
      throw new AppError("Email already exists.", 409);
    }

    const hashedPWD = await bcrypt.hash(password, 12);

    const user = await User.create({
      name,
      email,
      password: hashedPWD,
    });

    return {
      user: {
        userId: user.userId,
        name: user.name,
        email: user.email,
      },
    };
  },

  async loginUser(data) {
    const { email, password } = data;

    const user = await User.findOne({ where: { email } });

    if (!user) {
      throw new UnauthorizedError("Invalid credentials.");
    }

    const isEqual = await bcrypt.compare(password, user.password);

    if (!isEqual) {
      throw new UnauthorizedError("Invalid credentials.");
    }

    const token = jwt.sign(
      {
        userId: user.userId,
        email: user.email,
      },
      jwtSecretKey,
      { expiresIn: jwtExpiresIn }
    );

    return {
      token,
      user: {
        userId: user.userId,
        name: user.name,
        email: user.email,
      },
    };
  },
};