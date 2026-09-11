// Loads api/.env during local development. In Railway, its own Variables are
// already in process.env, and dotenv simply does nothing if no file exists.
import "dotenv/config";

import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import mongoose from "mongoose";
import { registerRoutes } from "./routes.js";
import { attachSignaling } from "./signaling.js";
import { Device } from "./models.js";

const PORT = Number(process.env.PORT || 3780);
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/deskly";

// Validate MONGO_URI early
if (!MONGO_URI || MONGO_URI.length < 10) {
  console.error("[FATAL] MONGO_URI is not set. Check your api/.env file.");
  process.exit(1);
}

const app = Fastify({ logger: true });

// ── Global error handler — catches unhandled route errors ────────────────────
app.setErrorHandler(async (error, request, reply) => {
  const status = error.statusCode || 500;
  app.log.error({ err: error, url: request.url }, "Unhandled route error");
  if (status >= 500) {
    return reply.code(500).send({ error: "Internal server error. Please try again." });
  }
  return reply.code(status).send({ error: error.message || "Request failed." });
});

// ── Not-found handler ────────────────────────────────────────────────────────
app.setNotFoundHandler((request, reply) => {
  reply.code(404).send({ error: `Route ${request.method} ${request.url} not found.` });
});

await app.register(cors, { origin: true });
await app.register(websocket);
await registerRoutes(app);
attachSignaling(app);

// ── MongoDB connection with resilient fallback ──────────────────────────────
const MONGO_OPTS = {
  serverSelectionTimeoutMS: 6000,   // fail fast if Atlas unreachable (default 30s)
  socketTimeoutMS: 45000,
  connectTimeoutMS: 8000,
  maxPoolSize: 10,
  retryWrites: true,
};

let dbConnected = false;
let activeDbUri = MONGO_URI;

try {
  const redactedUri = MONGO_URI.replace(/:([^@]+)@/, ":***@");
  app.log.info(`[DB] Attempting MongoDB connection: ${redactedUri}`);
  await mongoose.connect(MONGO_URI, MONGO_OPTS);
  dbConnected = true;
  app.log.info(`[DB] Successfully connected to primary MongoDB: ${redactedUri}`);
} catch (err) {
  const isAtlas = MONGO_URI.includes("mongodb.net");
  const isAuthenticationError = /auth|authentication|not authorized/i.test(String(err.message || ""));
  app.log.warn(
    `\n═══════════════════════════════════════════════════════════════════\n` +
    `⚠️  PRIMARY MONGODB CONNECTION FAILED:\n` +
    `   Error: ${err.message}\n` +
    (isAtlas && isAuthenticationError
      ? `   NOTE: MongoDB Atlas rejected the database username or password in MONGO_URI.\n` +
        `   Fix: In Atlas -> Database Access, reset or create a database user, then update MONGO_URI in Railway Variables.\n`
      : isAtlas
      ? `   NOTE: MongoDB Atlas returned a connection rejection (often TLS alert 80).\n` +
        `   This means your current public IP is not in Atlas Network Access whitelist!\n` +
        `   To fix: In MongoDB Atlas console -> 'Network Access' -> Add IP Address -> '0.0.0.0/0' (Allow anywhere).\n`
      : "") +
    `═══════════════════════════════════════════════════════════════════`
  );

  // Attempt fallback to local MongoDB if available
  const LOCAL_URI = "mongodb://127.0.0.1:27017/deskly";
  if (MONGO_URI !== LOCAL_URI) {
    try {
      app.log.info(`[DB] Attempting fallback to local MongoDB (${LOCAL_URI})...`);
      await mongoose.connect(LOCAL_URI, { serverSelectionTimeoutMS: 3000 });
      dbConnected = true;
      activeDbUri = LOCAL_URI;
      app.log.info(`[DB] Successfully connected to fallback local MongoDB! Deskly is operational.`);
    } catch (localErr) {
      app.log.error(`[DB] Fallback to local MongoDB also failed: ${localErr.message}`);
    }
  }

  if (!dbConnected) {
    app.log.error("[FATAL] Could not connect to either MongoDB Atlas or local MongoDB. Exiting.");
    process.exit(1);
  }
}

// Ensure proper indexes
try {
  await Device.collection.dropIndex("role_1").catch((err) => {
    if (err.codeName !== "IndexNotFound") throw err;
  });
  await Device.collection.createIndex({ ownerId: 1, role: 1 }, { unique: true });
  app.log.info("[DB] Indexes verified successfully ✓");
} catch (indexErr) {
  app.log.warn(`[DB] Index setup warning: ${indexErr.message}`);
}

// ── Start HTTP + WS server ───────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`Deskly API listening on http://0.0.0.0:${PORT}`);
} catch (err) {
  app.log.error(`Failed to bind port ${PORT}: ${err.message}`);
  process.exit(1);
}

// ── Safety nets ──────────────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  app.log.error({ reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  app.log.error({ err }, "Uncaught exception — shutting down safely");
  process.exit(1);
});
