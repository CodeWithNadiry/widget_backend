import { Router } from "express";
import authRoutes from "../modules/auth/auth.route.js";
import adminRoutes from "../modules/admin/admin.route.js";
import chatbotRoutes from "../modules/chatbot/chatbot.route.js";
import propertyRoutes from "../modules/property/property.route.js";
import documentRoutes from "../modules/document/document.route.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/admin/chatbots", adminRoutes); 
router.use("/chatbot", chatbotRoutes);
router.use("/property", propertyRoutes);
router.use("/document", documentRoutes);  

export default router;