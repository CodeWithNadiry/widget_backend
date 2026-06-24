import { authService } from "./auth.service.js";

export async function register(req, res, next) {
  try {
    const { name, email, password } = req.body;

    const { user } = await authService.signupUser({ name, email, password });

    res.status(201).json({
      message: "Account created successfully.",
      user,
    });
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const { token, user } = await authService.loginUser({ email, password });

    res.status(200).json({
      message: "Logged in successfully.",
      token,
      user,
    });
  } catch (err) {
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    res.status(200).json({
      message: "Logged out successfully.",
    });
  } catch (err) {
    next(err);
  }
}