import { AppError } from "../utils/AppError.js";

export function verifyInternalKey(req, res, next) {
  const internalKey = req.headers["x-internal-key"];
  if (!internalKey || internalKey !== process.env.INTERNAL_API_KEY) {
    return next(new AppError("Unauthorized.", 401));
  }

  next();
}