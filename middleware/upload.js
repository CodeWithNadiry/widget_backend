import multer from "multer";
import fs from "fs";
import { AppError } from "../utils/AppError.js";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync("uploads/", { recursive: true }); // ← creates folder if missing
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "application/pdf",
    "text/plain",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError("Only .pdf, .docx, .txt allowed", 400), false);
  }
};

export const upload = multer({
  storage,
  fileFilter,
});