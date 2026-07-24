import { authService } from "../auth/auth.service.js";
import User from "../../models/user.model.js";
import { AppError, NotFoundError } from "../../utils/AppError.js";

export const usersService = {
  async createUser({ name, email, password, isActive }) {
    // role is intentionally never accepted from the caller — every user
    // created through this path is forced to "user". The only "admin" row
    // that can ever exist is the one created by the bootstrap script.
    const { user } = await authService.signupUser({
      name,
      email,
      password,
      role: "user",
      isActive: !!isActive,
    });

    return user;
  },

  async getAllUsers() {
    const users = await User.findAll({
      attributes: ["userId", "name", "email", "role", "isActive", "createdAt"],
      order: [["createdAt", "DESC"]],
    });

    return users;
  },

  async updateUser({ userId, updates, requestingUserId }) {
    const user = await User.findOne({ where: { userId } });
    if (!user) throw new NotFoundError("User not found.");

    if (user.role === "admin") {
      throw new AppError("The admin account can't be edited from here.", 403);
    }

    const allowed = {};
    if (updates.name !== undefined) allowed.name = updates.name;
    if (updates.email !== undefined) allowed.email = updates.email;
    if (updates.isActive !== undefined) allowed.isActive = updates.isActive;
    // role is never editable here — only "user" accounts exist to edit,
    // and this endpoint has no path to promote anyone to admin.

    await user.update(allowed);

    return {
      userId: user.userId,
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
    };
  },

  async deleteUser({ userId, requestingUserId }) {
    const user = await User.findOne({ where: { userId } });
    if (!user) throw new NotFoundError("User not found.");

    if (user.role === "admin") {
      throw new AppError("The admin account can't be deleted.", 403);
    }

    if (userId === requestingUserId) {
      // Can't actually happen given role checks above (the requester is
      // always the admin here), but guarding explicitly in case this
      // service is ever reused by a non-admin-gated route.
      throw new AppError("You can't delete your own account.", 403);
    }

    await user.destroy();
  },
};