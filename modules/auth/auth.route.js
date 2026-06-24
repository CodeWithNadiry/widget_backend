import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.js";
import { registerSchema, loginSchema } from "./auth.schema.js";
import { register, login, logout } from "./auth.controller.js";
import { isAuth } from "../../middleware/isAuth.js";

const router = Router();

// POST /auth/register
router.post("/register", validateRequest(registerSchema), register);

// POST /auth/login
router.post("/login", validateRequest(loginSchema), login);

// POST /auth/logout
router.post("/logout", isAuth, logout);

export default router;