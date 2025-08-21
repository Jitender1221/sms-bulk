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

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 80;

// Database Models
const Account = require("./models/Account");
const Template = require("./models/Template");
const Message = require("./models/Message");

// Configure multer for file uploads
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

// Middleware
app.use(
  cors({
    origin: ["http://localhost:8000", "http://127.0.0.1:8000"],
    credentials: true,
  })
);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

// Create required directories
["./sessions", "./uploads", "./data", "./.wwebjs_auth"].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Session configuration
app.use(
  session({
    store: new FileStore({ path: "./sessions" }),
    secret: process.env.SESSION_SECRET || "jitender@123",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  })
);

// Initialize WhatsApp clients and SSE clients
const whatsappClients = {};
const sseClients = {};

// Connect to MongoDB
mongoose
  .connect(
    process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/whatsapp_tool",
    {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
    }
  )
  .then(() => console.log("✅ MongoDB connected successfully"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

// Broadcast event to all SSE clients for an account
function broadcastEvent(accountId, type, data) {
  if (!sseClients[accountId]) return;

  sseClients[accountId].forEach((client) => {
    try {
      client.res.write(`event: ${type}\n`);
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error("Error sending SSE:", err);
      sseClients[accountId] = sseClients[accountId].filter(
        (c) => c.id !== client.id
      );
    }
  });
}

// Initialize WhatsApp client for an account
function initializeWhatsAppClient(accountId) {
  if (whatsappClients[accountId]) {
    return whatsappClients[accountId];
  }

  console.log(`⚡ Initializing WhatsApp client for account: ${accountId}`);

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
  });

  whatsappClients[accountId] = client;

  client.on("qr", async (qr) => {
    console.log(`📲 QR received for ${accountId}`);
    try {
      const qrImage = await qrcode.toDataURL(qr);
      broadcastEvent(accountId, "qr", { qr: qrImage });
      await Account.findOneAndUpdate(
        { accountId },
        { status: "initialized", lastActivity: Date.now() },
        { upsert: true }
      );
    } catch (err) {
      console.error("Error generating QR code:", err);
      broadcastEvent(accountId, "error", {
        message: "Failed to generate QR code",
      });
    }
  });

  client.on("ready", async () => {
    console.log(`✅ Client ${accountId} is ready!`);
    broadcastEvent(accountId, "ready", { message: "Client is ready" });
    await Account.findOneAndUpdate(
      { accountId },
      { status: "ready", lastActivity: Date.now() }
    );
  });

  client.on("authenticated", async () => {
    console.log(`🔑 Client ${accountId} authenticated`);
    broadcastEvent(accountId, "authenticated", {
      message: "Client authenticated",
    });
    await Account.findOneAndUpdate(
      { accountId },
      { status: "authenticated", lastActivity: Date.now() }
    );
  });

  client.on("auth_failure", (msg) => {
    console.log(`❌ Client ${accountId} auth failure`, msg);
    broadcastEvent(accountId, "auth_failure", { message: "Auth failure", msg });
  });

  client.on("disconnected", async (reason) => {
    console.log(`⚠️ Client ${accountId} disconnected`, reason);
    broadcastEvent(accountId, "disconnected", { reason });
    await Account.findOneAndUpdate(
      { accountId },
      { status: "disconnected", lastActivity: Date.now() }
    );
    delete whatsappClients[accountId];
  });

  client.on("message", (msg) => {
    console.log(`💬 [${accountId}] ${msg.from}: ${msg.body}`);
  });

  client.on("error", (err) => {
    console.error(`Client error for ${accountId}:`, err);
    broadcastEvent(accountId, "error", { message: err.message });
  });

  client.initialize().catch((err) => {
    console.error(`Failed to initialize client for ${accountId}:`, err);
    broadcastEvent(accountId, "error", {
      message: `Initialization failed: ${err.message}`,
    });
  });

  return client;
}

/* ================== ROUTES ================== */

// Get all accounts
app.get("/api/accounts", async (req, res) => {
  try {
    const accounts = await Account.find().sort({ createdAt: -1 });
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create new account
app.post("/api/accounts", async (req, res) => {
  const { accountId } = req.body;

  if (!accountId) {
    return res
      .status(400)
      .json({ success: false, error: "Account ID is required" });
  }

  try {
    const existingAccount = await Account.findOne({ accountId });
    if (existingAccount) {
      return res
        .status(400)
        .json({ success: false, error: "Account already exists" });
    }

    const newAccount = new Account({ accountId });
    await newAccount.save();

    initializeWhatsAppClient(accountId);

    res.json({
      success: true,
      message: `Account ${accountId} initialized`,
      account: newAccount,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Activate account
app.post("/api/accounts/activate", (req, res) => {
  const { accountId } = req.body;
  if (!accountId)
    return res
      .status(400)
      .json({ success: false, error: "Account ID is required" });

  initializeWhatsAppClient(accountId);
  res.json({ success: true, message: `Account ${accountId} activated` });
});

// Logout account
app.post("/api/accounts/logout", async (req, res) => {
  const { accountId } = req.body;
  if (!accountId)
    return res
      .status(400)
      .json({ success: false, error: "Account ID is required" });

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
        { status: "disconnected", lastActivity: Date.now() }
      );

      res.json({ success: true, message: `Account ${accountId} logged out` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  } else {
    res.json({ success: true, message: `No active session for ${accountId}` });
  }
});

// SSE endpoint for account events
app.get("/api/accounts/:accountId/events", (req, res) => {
  const { accountId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const clientId = Date.now();
  if (!sseClients[accountId]) sseClients[accountId] = [];

  sseClients[accountId].push({ id: clientId, res });

  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ message: "Connected to SSE" })}\n\n`);

  initializeWhatsAppClient(accountId);

  req.on("close", () => {
    console.log(`Client ${clientId} disconnected from SSE`);
    sseClients[accountId] = sseClients[accountId].filter(
      (c) => c.id !== clientId
    );
  });
});

// Send message
app.post("/api/send-message", async (req, res) => {
  let { phone, message, media, accountId = "default" } = req.body;

  if (!phone)
    return res
      .status(400)
      .json({ success: false, error: "Phone number is required" });
  if (!message && !media?.url)
    return res
      .status(400)
      .json({ success: false, error: "Message or media required" });

  const client = whatsappClients[accountId];
  if (!client)
    return res.status(400).json({
      success: false,
      error: `Client for ${accountId} not initialized`,
    });

  try {
    let formattedPhone = phone.replace(/\D/g, "");
    if (formattedPhone.length < 10)
      return res
        .status(400)
        .json({ success: false, error: "Invalid phone number" });
    if (!formattedPhone.startsWith("55"))
      formattedPhone = "55" + formattedPhone;
    formattedPhone += "@c.us";

    let response;
    const messageRecord = new Message({
      accountId,
      phone: formattedPhone,
      message,
      media,
      status: "sending",
    });
    await messageRecord.save();

    if (media?.url) {
      const mediaPath = path.join(__dirname, media.url);
      if (!fs.existsSync(mediaPath)) {
        messageRecord.status = "failed";
        messageRecord.error = "Media not found";
        await messageRecord.save();
        return res
          .status(400)
          .json({ success: false, error: "Media not found" });
      }

      const fileData = fs.readFileSync(mediaPath);
      const msgMedia = new MessageMedia(
        "application/octet-stream",
        fileData.toString("base64"),
        path.basename(mediaPath)
      );

      response = await client.sendMessage(formattedPhone, msgMedia, {
        caption: message || media.caption || "",
      });
    } else {
      response = await client.sendMessage(formattedPhone, message);
    }

    messageRecord.status = "delivered";
    messageRecord.messageId = response.id.id;
    await messageRecord.save();

    res.json({ success: true, message: "Message sent", response });
  } catch (err) {
    console.error("Error sending message:", err);
    const failedRecord = new Message({
      accountId,
      phone,
      message,
      media,
      status: "failed",
      error: err.message,
    });
    await failedRecord.save();
    res.status(500).json({ success: false, error: err.message });
  }
});

// File upload
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, error: "No file uploaded" });

  try {
    const fileExt = path.extname(req.file.originalname);
    const newFileName = `${req.file.filename}${fileExt}`;
    const newPath = path.join(__dirname, "uploads", newFileName);
    fs.renameSync(req.file.path, newPath);

    res.json({
      success: true,
      url: `/uploads/${newFileName}`,
      originalName: req.file.originalname,
    });
  } catch (err) {
    console.error("Error uploading file:", err);
    res.status(500).json({ success: false, error: "Failed to upload file" });
  }
});

// Template CRUD
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
      { name, content, updatedAt: Date.now() },
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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  initializeWhatsAppClient("default"); // Auto-init default client
});
