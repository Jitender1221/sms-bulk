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

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

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
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
  })
);
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));
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

// Initialize WhatsApp client with faster options
function initializeWhatsAppClient(accountId) {
  if (whatsappClients[accountId]) {
    return whatsappClients[accountId];
  }

  console.log(`Initializing WhatsApp client for account: ${accountId}`);

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
        "--single-process",
        "--disable-gpu",
      ],
    },
    webVersionCache: {
      type: "remote",
      remotePath:
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
    },
  });

  whatsappClients[accountId] = client;

  client.on("qr", async (qr) => {
    console.log(`QR received for ${accountId}`);
    try {
      // Generate QR code as data URL for faster display
      const qrImage = await qrcode.toDataURL(qr, {
        width: 300,
        margin: 1,
        color: {
          dark: "#000000",
          light: "#FFFFFF",
        },
      });

      broadcastEvent(accountId, "qr", { qr: qrImage });
    } catch (err) {
      console.error("Error generating QR code:", err);
      broadcastEvent(accountId, "error", {
        message: "Failed to generate QR code",
      });
    }
  });

  client.on("ready", () => {
    console.log(`Client ${accountId} is ready!`);
    broadcastEvent(accountId, "ready", { message: "Client is ready" });
  });

  client.on("authenticated", () => {
    console.log(`Client ${accountId} authenticated`);
    broadcastEvent(accountId, "authenticated", {
      message: "Client authenticated",
    });
  });

  client.on("auth_failure", (msg) => {
    console.log(`Client ${accountId} auth failure`, msg);
    broadcastEvent(accountId, "auth_failure", { message: "Auth failure", msg });
  });

  client.on("disconnected", (reason) => {
    console.log(`Client ${accountId} disconnected`, reason);
    broadcastEvent(accountId, "disconnected", { reason });
    delete whatsappClients[accountId];
  });

  client.on("message", async (msg) => {
    console.log(`[${accountId}] Message from ${msg.from}: ${msg.body}`);
  });

  client.initialize().catch((err) => {
    console.error(`Failed to initialize client for ${accountId}:`, err);
    broadcastEvent(accountId, "error", {
      message: `Initialization failed: ${err.message}`,
    });
  });

  return client;
}

// Broadcast events to all SSE clients for an account
function broadcastEvent(accountId, type, data) {
  if (!sseClients[accountId]) return;

  sseClients[accountId].forEach((client) => {
    try {
      client.res.write(`event: ${type}\n`);
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error("Error sending SSE:", err);
      // Remove disconnected client
      sseClients[accountId] = sseClients[accountId].filter(
        (c) => c.id !== client.id
      );
    }
  });
}

// Routes

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "Server is running" });
});

// Get all accounts
app.get("/api/accounts", (req, res) => {
  const accounts = [];

  // Check sessions directory for existing accounts
  if (fs.existsSync("./sessions")) {
    const files = fs.readdirSync("./sessions");
    files.forEach((file) => {
      if (file.startsWith("session-")) {
        const accountId = file.replace("session-", "");
        accounts.push({
          accountId: accountId,
          status: whatsappClients[accountId] ? "connected" : "disconnected",
        });
      }
    });
  }

  // Add default if no accounts found
  if (accounts.length === 0) {
    accounts.push({ accountId: "default", status: "disconnected" });
  }

  res.json({ success: true, accounts });
});

// Create new account
app.post("/api/accounts", (req, res) => {
  const { accountId } = req.body;

  if (!accountId) {
    return res
      .status(400)
      .json({ success: false, error: "Account ID is required" });
  }

  // Check if account already exists
  if (whatsappClients[accountId]) {
    return res
      .status(400)
      .json({ success: false, error: "Account already exists" });
  }

  initializeWhatsAppClient(accountId);
  res.json({ success: true, message: `Account ${accountId} initialized` });
});

// Activate account
app.post("/api/accounts/activate", (req, res) => {
  const { accountId } = req.body;

  if (!accountId) {
    return res
      .status(400)
      .json({ success: false, error: "Account ID is required" });
  }

  initializeWhatsAppClient(accountId);
  res.json({ success: true, message: `Account ${accountId} activated` });
});

// Logout account
app.post("/api/accounts/logout", async (req, res) => {
  const { accountId } = req.body;

  if (!accountId) {
    return res
      .status(400)
      .json({ success: false, error: "Account ID is required" });
  }

  if (whatsappClients[accountId]) {
    try {
      await whatsappClients[accountId].destroy();
      delete whatsappClients[accountId];

      // Delete session files
      const sessionPath = path.join(
        __dirname,
        ".wwebjs_auth",
        `session-${accountId}`
      );
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }

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
app.get("/api/templates", (req, res) => {
  const templatesPath = path.join(__dirname, "data", "templates.json");

  let templates = [];
  if (fs.existsSync(templatesPath)) {
    try {
      const data = fs.readFileSync(templatesPath, "utf8");
      templates = JSON.parse(data);
    } catch (err) {
      console.error("Error reading templates:", err);
    }
  }

  res.json({ success: true, templates });
});

// Save template
app.post("/api/templates", (req, res) => {
  const { name, content } = req.body;

  if (!name || !content) {
    return res
      .status(400)
      .json({ success: false, error: "Name and content are required" });
  }

  const templatesPath = path.join(__dirname, "data", "templates.json");
  let templates = [];

  if (fs.existsSync(templatesPath)) {
    try {
      const data = fs.readFileSync(templatesPath, "utf8");
      templates = JSON.parse(data);
    } catch (err) {
      console.error("Error reading templates:", err);
    }
  }

  // Check if template already exists
  const existingIndex = templates.findIndex((t) => t.name === name);
  if (existingIndex >= 0) {
    // Update existing template
    templates[existingIndex] = { name, content, updatedAt: new Date() };
  } else {
    // Add new template
    templates.push({
      name,
      content,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Save templates
  try {
    fs.writeFileSync(templatesPath, JSON.stringify(templates, null, 2));
    res.json({ success: true, message: "Template saved successfully" });
  } catch (err) {
    console.error("Error saving template:", err);
    res.status(500).json({ success: false, error: "Failed to save template" });
  }
});

// Delete template
app.delete("/api/templates/:name", (req, res) => {
  const { name } = req.params;

  const templatesPath = path.join(__dirname, "data", "templates.json");
  let templates = [];

  if (fs.existsSync(templatesPath)) {
    try {
      const data = fs.readFileSync(templatesPath, "utf8");
      templates = JSON.parse(data);
    } catch (err) {
      console.error("Error reading templates:", err);
    }
  }

  // Filter out the template to delete
  const filteredTemplates = templates.filter((t) => t.name !== name);

  // Save updated templates
  try {
    fs.writeFileSync(templatesPath, JSON.stringify(filteredTemplates, null, 2));
    res.json({ success: true, message: "Template deleted successfully" });
  } catch (err) {
    console.error("Error deleting template:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to delete template" });
  }
});

// Serve uploaded files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Error handling middleware
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
