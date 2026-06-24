import { AppError } from "./AppError.js";

export async function validate(files) {
  if (!files || files.length === 0) {
    throw new AppError("No files provided", 400)
  }
}