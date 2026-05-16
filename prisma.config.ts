import path from "path";
import { config } from "dotenv";

// Load the backend's .env (absolute path to avoid CWD ambiguity)
config({ path: path.resolve(__dirname, ".env") });

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: path.resolve(__dirname, "prisma/schema.prisma"),
  datasource: {
    url: process.env.DATABASE_URL as string,
  },
});
