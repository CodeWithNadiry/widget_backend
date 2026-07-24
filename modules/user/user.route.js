import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.js";
import { createUserSchema, updateUserSchema } from "./user.schema.js";
import {
  createUser,
  getAllUsers,
  updateUser,
  deleteUser,
} from "./user.controller.js";
import { isAuth } from "../../middleware/isAuth.js";
import { isAdmin } from "../../middleware/isAdmin.js";

const router = Router();

// Every route here requires an authenticated admin — this is the only
// surface in the whole app that can create a login-capable account.
router.use(isAuth, isAdmin);

// POST   /admin/users          — create a new (non-admin) user
router.post("/", validateRequest(createUserSchema), createUser);

// GET    /admin/users          — list all users
router.get("/", getAllUsers);

// PUT    /admin/users/:userId  — edit name/email/isActive
router.put("/:userId", validateRequest(updateUserSchema), updateUser);

// DELETE /admin/users/:userId  — remove a user
router.delete("/:userId", deleteUser);

export default router;