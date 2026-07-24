import { usersService } from "./user.service.js";

export async function createUser(req, res, next) {
  try {
    const { name, email, password, isActive } = req.body;

    const user = await usersService.createUser({ name, email, password, isActive });

    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
}

export async function getAllUsers(req, res, next) {
  try {
    const users = await usersService.getAllUsers();

    res.status(200).json({ users });
  } catch (err) {
    next(err);
  }
}

export async function updateUser(req, res, next) {
  try {
    const { userId } = req.params;
    const requestingUserId = req.userId;
    const updates = req.body;

    const user = await usersService.updateUser({ userId, updates, requestingUserId });

    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

export async function deleteUser(req, res, next) {
  try {
    const { userId } = req.params;
    const requestingUserId = req.userId;

    await usersService.deleteUser({ userId, requestingUserId });

    res.status(200).json({ message: "User deleted successfully." });
  } catch (err) {
    next(err);
  }
}