/**
 * Gurukripa Career Institute – WhatsApp Web Tool
 * Single-file Express server (server.js)
 */

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

/* ---------- MongoDB Schemas ---------- */
const accountSchema = new mongoose.Schema({
  accountId: { type: String, required: true, unique: true },
  status: { type: String, default: "initialized" },
  lastActivity: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

const templateSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  content: { type: String, required: true },
  variables: [{ type: String }],
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

/* ---------- Express Setup ---------- */
app.use(
  cors({
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
  })
);
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));
app.use(fileUpload());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

["./sessions", "./uploads", "./data", "./.wwebjs_auth"].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

/* ---------- Multer ---------- */
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, "uploads/"),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

/* ---------- Globals ---------- */
const whatsappClients = {};
const sseClients = {};

/* ---------- Utility: broadcast to SSE ---------- */
function broadcastEvent(accountId, type, data) {
  if (!sseClients[accountId]) return;
  sseClients[accountId].forEach((c) => {
    try {
      c.res.write(`event: ${type}\n`);
      c.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      sseClients[accountId] = sseClients[accountId].filter(
        (x) => x.id !== c.id
      );
    }
  });
}

/* ---------- WhatsApp Client Factory ---------- */
function initializeWhatsAppClient(accountId) {
  if (whatsappClients[accountId]) return whatsappClients[accountId];

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: accountId }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
      ],
    },
    webVersionCache: {
      type: "remote",
      remotePath:
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
    },
  });

  /* --- Events --- */
  client.on("qr", async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    broadcastEvent(accountId, "qr", { qr: qrImage });
  });

  client.on("authenticated", async () => {
    await Account.findOneAndUpdate(
      { accountId },
      { status: "authenticated", lastActivity: new Date() },
      { upsert: true, new: true }
    );
    broadcastEvent(accountId, "connected", {
      message: "Authenticated, please wait...",
    });
  });

  client.on("ready", async () => {
    await Account.findOneAndUpdate(
      { accountId },
      { status: "ready", lastActivity: new Date() },
      { upsert: true, new: true }
    );
    broadcastEvent(accountId, "ready", { message: "✅ Connected and ready" });
  });

  client.on("disconnected", async (reason) => {
    await Account.findOneAndUpdate(
      { accountId },
      { status: "disconnected", lastActivity: new Date() }
    );
    delete whatsappClients[accountId];
    broadcastEvent(accountId, "disconnected", { reason });
  });

  client.initialize().catch((err) => {
    console.error(`Failed to initialize client for ${accountId}:`, err);
    broadcastEvent(accountId, "error", { message: err.message });
  });

  whatsappClients[accountId] = client;
  return client;
}

/* ---------- Mongoose ---------- */
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/whatsapp_tool")
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

/* ---------- REST Endpoints ---------- */
app.get("/api/health", (_, res) => res.json({ success: true }));

/* Accounts */
app.get("/api/accounts", async (_, res) => {
  try {
    const accounts = await Account.find().sort({ createdAt: -1 });
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/accounts", async (req, res) => {
  const { accountId } = req.body;
  if (!accountId)
    return res
      .status(400)
      .json({ success: false, error: "Account ID required" });

  try {
    if (await Account.exists({ accountId }))
      return res
        .status(400)
        .json({ success: false, error: "Account already exists" });

    await new Account({ accountId }).save();
    initializeWhatsAppClient(accountId);
    res.json({ success: true, message: `Account ${accountId} initialized` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/accounts/activate", (req, res) => {
  const { accountId } = req.body;
  if (!accountId)
    return res
      .status(400)
      .json({ success: false, error: "Account ID required" });
  initializeWhatsAppClient(accountId);
  res.json({ success: true, message: `Account ${accountId} activated` });
});

app.post("/api/accounts/logout", async (req, res) => {
  const { accountId } = req.body;
  if (!accountId)
    return res
      .status(400)
      .json({ success: false, error: "Account ID required" });

  try {
    if (whatsappClients[accountId]) {
      await whatsappClients[accountId].destroy();
      delete whatsappClients[accountId];
    }

    const authDir = path.join(
      __dirname,
      ".wwebjs_auth",
      `session-${accountId}`
    );
    if (fs.existsSync(authDir))
      fs.rmSync(authDir, { recursive: true, force: true });

    await Account.findOneAndUpdate(
      { accountId },
      { status: "disconnected", lastActivity: new Date() }
    );
    res.json({ success: true, message: `Account ${accountId} logged out` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/accounts/:accountId/refresh", (req, res) => {
  const { accountId } = req.params;
  if (!whatsappClients[accountId])
    return res
      .status(400)
      .json({ success: false, error: "Client not initialized" });

  whatsappClients[accountId]
    .destroy()
    .then(() => {
      delete whatsappClients[accountId];
      initializeWhatsAppClient(accountId);
      res.json({ success: true, message: "QR refresh initiated" });
    })
    .catch((err) =>
      res.status(500).json({ success: false, error: err.message })
    );
});

/* SSE */
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

  res.write(
    `event: connected\ndata: ${JSON.stringify({
      message: "Connected to SSE",
    })}\n\n`
  );
  initializeWhatsAppClient(accountId);

  req.on("close", () => {
    sseClients[accountId] = (sseClients[accountId] || []).filter(
      (c) => c.id !== clientId
    );
  });
});

/* Templates */
app.get("/api/templates", async (_, res) => {
  try {
    const templates = await Template.find().sort({ createdAt: -1 });
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/templates", async (req, res) => {
  const { name, content } = req.body;
  if (!name || !content)
    return res
      .status(400)
      .json({ success: false, error: "Name and content required" });

  try {
    const variables = (content.match(/\{\{([^}]+)\}\}/g) || []).map((v) =>
      v.slice(2, -2)
    );
    await Template.findOneAndUpdate(
      { name },
      { content, variables, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/templates/:id", async (req, res) => {
  try {
    await Template.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* Message send */
app.post("/api/send-message", async (req, res) => {
  let { phone, message, media, accountId = "default" } = req.body;
  if (!phone)
    return res.status(400).json({ success: false, error: "Phone required" });
  if (!message && !media?.url)
    return res
      .status(400)
      .json({ success: false, error: "Message or media required" });

  const client = whatsappClients[accountId];
  if (!client)
    return res.status(400).json({
      success: false,
      error: `Client for ${accountId} not initialized. Please scan the QR first.`,
    });

  try {
    let formattedPhone = String(phone).replace(/\D/g, "");
    if (!formattedPhone.startsWith("55") && !formattedPhone.startsWith("91"))
      formattedPhone = "91" + formattedPhone; // default India
    formattedPhone += "@c.us";

    let response;
    if (media?.url) {
      const mediaPath = path.join(__dirname, media.url);
      if (!fs.existsSync(mediaPath))
        return res
          .status(400)
          .json({ success: false, error: "Media file not found" });

      const mediaData = MessageMedia.fromFilePath(mediaPath);
      response = await client.sendMessage(formattedPhone, mediaData, {
        caption: message || media.caption || "",
      });
    } else {
      response = await client.sendMessage(formattedPhone, message);
    }

    await new Message({
      accountId,
      phone: formattedPhone,
      message,
      media,
      messageId: response.id.id,
    }).save();

    res.json({ success: true, message: "Message sent", response });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* File upload */
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, error: "No file uploaded" });
  res.json({
    success: true,
    url: `/uploads/${req.file.filename}`,
    originalName: req.file.originalname,
  });
});

/* SPA fallback */
app.get("*", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

/* error handler */
app.use((err, _req, res, _next) => {
  console.error("Server error:", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

/* ---------- Bootstrap ---------- */
initializeWhatsAppClient("default");

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
