import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.js";
import { loginSchema } from "./auth.schema.js";
import { login, logout } from "./auth.controller.js";
import { isAuth } from "../../middleware/isAuth.js";

const router = Router();

// POST /auth/login
router.post("/login", validateRequest(loginSchema), login);

// POST /auth/logout
router.post("/logout", isAuth, logout);

export default router;