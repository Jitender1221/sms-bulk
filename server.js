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

/* ---------- Mongoose ---------- */
mongoose.connect(
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/whatsapp_tool",
  {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  }
);

// Account Schema
const accountSchema = new mongoose.Schema({
  accountId: { type: String, required: true, unique: true },
  status: { type: String, default: "initialized" },
  lastActivity: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

// Template Schema
const templateSchema = new mongoose.Schema({
  name: { type: String, required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const Account = mongoose.model("Account", accountSchema);
const Template = mongoose.model("Template", templateSchema);

/* ---------- Express ---------- */
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

/* ---------- WhatsApp ---------- */
const whatsappClients = {};
const sseClients = {};

function broadcast(accountId, type, data) {
  if (!sseClients[accountId]) return;
  sseClients[accountId].forEach((c) => {
    try {
      c.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      sseClients[accountId] = sseClients[accountId].filter(
        (x) => x.id !== c.id
      );
    }
  });
}

function initializeWhatsAppClient(accountId) {
  if (whatsappClients[accountId]) {
    if (whatsappClients[accountId].isReady) {
      broadcast(accountId, "ready", { message: "✅ Already connected" });
      return whatsappClients[accountId];
    }
    // Already starting – avoid duplicate
    return whatsappClients[accountId];
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: accountId }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    },
    webVersionCache: {
      type: "remote",
      remotePath:
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
    },
  });

  client.isReady = false;
  client.accountId = accountId;
  whatsappClients[accountId] = client;

  client.on("qr", async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    broadcast(accountId, "qr", { qr: qrImage });
  });

  client.on("authenticated", async () => {
    broadcast(accountId, "authenticated", {
      message: "Authenticated, please wait...",
    });
    await Account.findOneAndUpdate(
      { accountId },
      { status: "authenticated", lastActivity: new Date() },
      { upsert: true }
    );
  });

  client.on("ready", async () => {
    client.isReady = true;
    broadcast(accountId, "ready", { message: "✅ Connected and ready" });
    await Account.findOneAndUpdate(
      { accountId },
      { status: "ready", lastActivity: new Date() },
      { upsert: true }
    );
  });

  client.on("disconnected", async (reason) => {
    client.isReady = false;
    broadcast(accountId, "disconnected", { reason });
    await Account.findOneAndUpdate(
      { accountId },
      { status: "disconnected", lastActivity: new Date() }
    );
    delete whatsappClients[accountId];
  });

  client.on("auth_failure", async (msg) => {
    broadcast(accountId, "auth_failure", { msg });
    await Account.findOneAndUpdate(
      { accountId },
      { status: "auth_failure", lastActivity: new Date() }
    );
  });

  client.initialize().catch((err) => {
    console.error(`Failed to initialize ${accountId}:`, err);
    broadcast(accountId, "error", { message: err.message });
  });

  return client;
}

/* ---------- Routes ---------- */
app.get("/api/health", (_req, res) =>
  res.json({ success: true, message: "Server is running" })
);

app.get("/api/accounts", async (_req, res) => {
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
  if (/\s/.test(accountId))
    return res.status(400).json({ success: false, error: "No spaces allowed" });

  try {
    if (await Account.findOne({ accountId }))
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

  if (whatsappClients[accountId]) {
    try {
      await whatsappClients[accountId].destroy();
      delete whatsappClients[accountId];
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
  } else {
    res.json({ success: true, message: `No active session for ${accountId}` });
  }
});

// Refresh QR code
app.post("/api/accounts/:accountId/refresh", (req, res) => {
  const { accountId } = req.params;

  if (!whatsappClients[accountId]) {
    return res
      .status(400)
      .json({ success: false, error: "Client not initialized" });
  }

  // Force a fresh authentication by resetting the client
  if (whatsappClients[accountId]) {
    whatsappClients[accountId]
      .destroy()
      .then(() => {
        delete whatsappClients[accountId];
        initializeWhatsAppClient(accountId);
        res.json({ success: true, message: "QR refresh initiated" });
      })
      .catch((err) => {
        res.status(500).json({ success: false, error: err.message });
      });
  }
});

// SSE endpoint for account events
app.get("/api/accounts/:accountId/events", (req, res) => {
  const { accountId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const clientId = Date.now();
  if (!sseClients[accountId]) {
    sseClients[accountId] = [];
  }

  sseClients[accountId].push({ id: clientId, res });

  // Send initial connected event
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ message: "Connected to SSE" })}\n\n`);

  // Initialize the client if not already done
  initializeWhatsAppClient(accountId);

  req.on("close", () => {
    console.log(`Client ${clientId} disconnected from SSE`);
    sseClients[accountId] = sseClients[accountId].filter(
      (client) => client.id !== clientId
    );
  });
});

// Send message
app.post("/api/send-message", async (req, res) => {
  let { phone, message, media, accountId = "default" } = req.body;

  // Debug log to see what's being received
  console.log("Received send message request:", {
    phone,
    message,
    media,
    accountId,
  });

  if (!phone) {
    return res
      .status(400)
      .json({ success: false, error: "Phone number is required" });
  }

  // Ensure phone is a string
  if (typeof phone !== "string") {
    phone = String(phone);
  }

  if (!message && !media?.url) {
    return res
      .status(400)
      .json({ success: false, error: "Message or media is required" });
  }

  const client = whatsappClients[accountId];
  if (!client) {
    return res.status(400).json({
      success: false,
      error: `Client for ${accountId} not initialized. Please scan the QR code first.`,
    });
  }

  try {
    // Format phone number - ensure it's a string first
    let formattedPhone = String(phone).replace(/\D/g, "");

    // Add country code if missing
    if (!formattedPhone.startsWith("55") && !formattedPhone.startsWith("91")) {
      formattedPhone = "91" + formattedPhone; // Default to India code
    }

    formattedPhone += "@c.us";

    let response;

    if (media?.url) {
      // Handle media message
      const mediaPath = path.join(__dirname, media.url);

      if (!fs.existsSync(mediaPath)) {
        return res
          .status(400)
          .json({ success: false, error: "Media file not found" });
      }

      const mediaData = MessageMedia.fromFilePath(mediaPath);
      response = await client.sendMessage(formattedPhone, mediaData, {
        caption: message || media.caption || "",
      });
    } else {
      // Handle text message
      response = await client.sendMessage(formattedPhone, message);
    }

    res.json({ success: true, message: "Message sent", response });
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// File upload
app.post("/api/upload", (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).json({ success: false, error: "No file uploaded" });
  }

  const file = req.files.file;
  const uploadDir = path.join(__dirname, "uploads");

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const filename = `${Date.now()}-${file.name}`;
  const filepath = path.join(uploadDir, filename);

  file.mv(filepath, (err) => {
    if (err) {
      console.error("Error uploading file:", err);
      return res
        .status(500)
        .json({ success: false, error: "Failed to upload file" });
    }

    res.json({
      success: true,
      url: `/uploads/${filename}`,
      originalName: file.name,
    });
  });
});

// Get message templates
app.get("/api/templates", async (req, res) => {
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
    const newTemplate = new Template({ name, content });
    await newTemplate.save();
    res.json({ success: true, template: newTemplate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/api/templates/:id", async (req, res) => {
  const { id } = req.params;
  const { name, content } = req.body;
  if (!name || !content)
    return res
      .status(400)
      .json({ success: false, error: "Name and content required" });

  try {
    const updated = await Template.findByIdAndUpdate(
      id,
      { name, content, updatedAt: new Date() },
      { new: true }
    );
    if (!updated)
      return res
        .status(404)
        .json({ success: false, error: "Template not found" });
    res.json({ success: true, template: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/templates/:id", async (req, res) => {
  try {
    const deleted = await Template.findByIdAndDelete(req.params.id);
    if (!deleted)
      return res
        .status(404)
        .json({ success: false, error: "Template not found" });
    res.json({ success: true, message: "Template deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Error handling
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

// Initialize default client on startup
initializeWhatsAppClient("default");

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp Web Client available at http://localhost:${PORT}`);
});