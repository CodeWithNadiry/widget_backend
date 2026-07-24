import bcrypt from "bcryptjs";
import User from "../models/user.model.js";

// Runs on every server start, but only actually creates anything the very
// first time — once an admin row exists, this is a no-op count() check.
export async function bootstrapAdmin() {
  const existingAdminCount = await User.count({ where: { role: "admin" } });
  if (existingAdminCount > 0) return;

  const email = process.env.ADMIN_EMAIL || "admin@hotelbot.local";
  const password = process.env.ADMIN_PASSWORD || "ChangeMe123!";
  const name = process.env.ADMIN_NAME || "Admin";

  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    console.warn(
      "⚠️  ADMIN_EMAIL / ADMIN_PASSWORD not set in .env — using fallback " +
      "defaults for the seeded admin account. Set these in .env and change " +
      "the password after first login.",
    );
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  await User.create({
    name,
    email,
    password: hashedPassword,
    role: "admin",
    isActive: true,
  });

  console.log(`✅ Default admin created — email: ${email}`);
}