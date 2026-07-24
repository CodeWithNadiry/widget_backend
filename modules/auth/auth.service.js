import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../../models/user.model.js";
import { AppError, UnauthorizedError } from "../../utils/AppError.js";
import { configData } from "../../config/config.js";

const { jwtSecretKey, jwtExpiresIn } = configData;

export const authService = {
  // Kept for internal use only (the bootstrap script and the admin-only
  // user-creation endpoint both call this) — there is no public route that
  // reaches it anymore. Callers control role/isActive explicitly; this
  // function itself doesn't decide either, to keep the "only the bootstrap
  // creates an admin" rule enforced at the call sites, not buried here.
  async signupUser({ name, email, password, role = "user", isActive = false }) {
    const existingUser = await User.findOne({ where: { email } });

    if (existingUser) {
      throw new AppError("Email already exists.", 409);
    }

    const hashedPWD = await bcrypt.hash(password, 12);

    const user = await User.create({
      name,
      email,
      password: hashedPWD,
      role,
      isActive,
    });

    return {
      user: {
        userId: user.userId,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
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

    if (!user.isActive) {
      throw new AppError(
        "Your account is inactive. Contact your admin to have it activated.",
        403,
      );
    }

    const token = jwt.sign(
      {
        userId: user.userId,
        email: user.email,
        role: user.role,
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
        role: user.role,
      },
    };
  },
};