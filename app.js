import express from "express";
import cors from "cors";
import { config } from "dotenv";
import routes from './routes/index.js'
import { connectDB } from "./db/client.js";
import { initModels } from "./models/index.js";
import { errorHandler } from "./middleware/errorHandler.js";

config(); // loads .env

const app = express();

// Middlware
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://widget-frontend-three.vercel.app",        // ← update after Step 9
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));


app.use(express.json());

console.log('app running in full')
// Routes
app.use('/', routes)

// Global error handler
app.use(errorHandler);

// Bootstrap function
const start = async () => {
  await connectDB();

  initModels();

  const PORT = process.env.PORT || 8080;

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

start();
