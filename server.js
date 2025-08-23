require("dotenv").config();
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const cors = require("cors");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const fileUpload = require("express-fileupload");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Mongo ──
const accountSchema = new mongoose.Schema({
  accountId: { type: String, required: true, unique: true },
  status: { type: String, default: "initialized" },
  lastActivity: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});
const templateSchema = new mongoose.Schema({
  name: { type: String, required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
const messageSchema = new mongoose.Schema({
  accountId: { type: String, required: true },
  phone: { type: String, required: true },
  message: String,
  media: Object,
  status: { type: String, default: "sending" },
  error: String,
  messageId: String,
  createdAt: { type: Date, default: Date.now },
});
const Account = mongoose.model("Account", accountSchema);
const Template = mongoose.model("Template", templateSchema);
const Message = mongoose.model("Message", messageSchema);

mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/whatsapp_tool", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// ── Multer / Uploads ──
const storage = multer.diskStorage({
  destination: (_, __, cb) => {
    const dir = "uploads/";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── Middleware ──
app.use(cors({ origin: ["http://localhost:3000", "http://127.0.0.1:3000"], credentials: true }));
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));
app.use(fileUpload());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));
["./sessions", "./uploads", "./data", "./.wwebjs_auth"].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
app.use(
  session({
    store: new FileStore({ path: "./sessions" }),
    secret: process.env.SESSION_SECRET || "jitender@123",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  })
);

// ── WhatsApp clients / SSE ──
const whatsappClients = {};
const sseClients = {};

function broadcast(accountId, type, data) {
  if (!sseClients[accountId]) return;
  sseClients[accountId].forEach((c) => {
    try {
      c.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      sseClients[accountId] = sseClients[accountId].filter((x) => x.id !== c.id);
    }
  });
}

function initializeWhatsAppClient(accountId) {
  if (whatsappClients[accountId] && whatsappClients[accountId].isReady) {
    broadcast(accountId, "ready", { message: "✅ Already connected" });
    return whatsappClients[accountId];
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: accountId }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--single-process"],
    },
    webVersionCache: {
      type: "remote",
      remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
    },
  });

  client.isReady = false;
  client.accountId = accountId;
  whatsappClients[accountId] = client;

  client.on("qr", async (qr) => {
    const img = await qrcode.toDataURL(qr);
    broadcast(accountId, "qr", { qr: img });
  });

  client.on("authenticated", () => {
    broadcast(accountId, "authenticated", { message: "Authenticated, please wait..." });
    Account.findOneAndUpdate({ accountId }, { status: "authenticated", lastActivity: new Date() }, { upsert: true, new: true });
  });

  client.on("ready", () => {
    client.isReady = true;
    broadcast(accountId, "ready", { message: "✅ Connected and ready" });
    Account.findOneAndUpdate({ accountId }, { status: "ready", lastActivity: new Date() }, { upsert: true, new: true });
  });

  client.on("disconnected", (reason) => {
    client.isReady = false;
    broadcast(accountId, "disconnected", { reason });
    Account.findOneAndUpdate({ accountId }, { status: "disconnected", lastActivity: new Date() });
    delete whatsappClients[accountId];
  });

  client.on("auth_failure", (msg) => {
    broadcast(accountId, "auth_failure", { msg });
    Account.findOneAndUpdate({ accountId }, { status: "auth_failure", lastActivity: new Date() });
  });

  client.initialize();
  return client;
}

// ── REST endpoints ──
app.get("/api/health", (_, res) => res.json({ success: true }));
app.get("/api/accounts", async (_, res) => {
  try {
    const accounts = await Account.find().sort({ createdAt: -1 });
    res.json({ success: true, accounts });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/api/accounts", async (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ success: false, error: "Account ID required" });
  if (accountId.includes(" ")) return res.status(400).json({ success: false, error: "No spaces" });
  try {
    const exists = await Account.findOne({ accountId });
    if (exists) return res.status(400).json({ success: false, error: "Account exists" });
    await new Account({ accountId }).save();
    initializeWhatsAppClient(accountId);
    res.json({ success: true, message: `${accountId} initialized` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/api/accounts/activate", (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ success: false, error: "Account ID required" });
  initializeWhatsAppClient(accountId);
  res.json({ success: true, message: `${accountId} activated` });
});
app.post("/api/accounts/logout", async (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ success: false, error: "Account ID required" });
  try {
    if (whatsappClients[accountId]) {
      await whatsappClients[accountId].destroy();
      delete whatsappClients[accountId];
    }
    const authDir = path.join(__dirname, ".wwebjs_auth", `session-${accountId}`);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    await Account.findOneAndUpdate({ accountId }, { status: "disconnected", lastActivity: new Date() });
    res.json({ success: true, message: `${accountId} logged out` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/api/accounts/:accountId/refresh", (req, res) => {
  const { accountId } = req.params;
  if (!whatsappClients[accountId]) return res.status(400).json({ success: false, error: "Client not initialized" });
  whatsappClients[accountId]
    .destroy()
    .then(() => {
      delete whatsappClients[accountId];
      initializeWhatsAppClient(accountId);
      res.json({ success: true, message: "QR refresh initiated" });
    })
    .catch((e) => res.status(500).json({ success: false, error: e.message }));
});

// SSE
app.get("/api/accounts/:accountId/events", (req, res) => {
  const { accountId } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  const clientId = Date.now();
  if (!sseClients[accountId]) sseClients[accountId] = [];
  sseClients[accountId].push({ id: clientId, res });
  res.write(`event: connected\ndata: ${JSON.stringify({ message: "Connected to SSE" })}\n\n`);
  initializeWhatsAppClient(accountId);
  req.on("close", () => {
    sseClients[accountId] = sseClients[accountId].filter((c) => c.id !== clientId);
  });
});

// Send message
app.post("/api/send-message", async (req, res) => {
  let { phone, message, media, accountId = "default" } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: "Phone required" });
  if (!message && !media?.url) return res.status(400).json({ success: false, error: "Message or media required" });
  const client = whatsappClients[accountId];
  if (!client || !client.isReady) return res.status(400).json({ success: false, error: "Client not ready" });
  try {
    const formatted = String(phone).replace(/\D/g, "");
    const chatId = `${formatted.includes("91") ? "" : "91"}${formatted}@c.us`;
    let response;
    if (media?.url) {
      const mediaPath = path.join(__dirname, media.url);
      if (!fs.existsSync(mediaPath)) return res.status(400).json({ success: false, error: "Media not found" });
      const mediaObj = MessageMedia.fromFilePath(mediaPath);
      response = await client.sendMessage(chatId, mediaObj, { caption: message || media.caption || "" });
    } else {
      response = await client.sendMessage(chatId, message);
    }
    res.json({ success: true, response });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// File upload
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file" });
  res.json({ success: true, url: `/uploads/${req.file.filename}`, originalName: req.file.originalname });
});

// Templates
app.get("/api/templates", async (_, res) => {
  try {
    const templates = await Template.find().sort({ createdAt: -1 });
    res.json({ success: true, templates });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/api/templates", async (req, res) => {
  const { name, content } = req.body;
  if (!name || !content) return res.status(400).json({ success: false, error: "Name & content required" });
  try {
    const template = new Template({ name, content });
    await template.save();
    res.json({ success: true, template });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.put("/api/templates/:id", async (req, res) => {
  const { name, content } = req.body;
  if (!name || !content) return res.status(400).json({ success: false, error: "Name & content required" });
  try {
    const updated = await Template.findByIdAndUpdate(req.params.id, { name, content, updatedAt: new Date() }, { new: true });
    if (!updated) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, template: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.delete("/api/templates/:id", async (req, res) => {
  try {
    const deleted = await Template.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, message: "Deleted" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Serve SPA
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Global error handler
app.use((err, _, res, __) => {
  console.error("Server error:", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

// Start
initializeWhatsAppClient("default");
app.listen(PORT, () => {
  console.log(`🚀 Server on http://localhost:${PORT}`);
});
