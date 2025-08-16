require("dotenv").config();
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const xlsx = require("xlsx");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
// Configuration
const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, "sessions");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const LOGS_DIR = path.join(__dirname, "logs");

// Ensure directories exist
[UPLOADS_DIR, LOGS_DIR, SESSIONS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

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
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

// Directories to ensure exist
const dirs = ["public", "sessions", "uploads", "logs"];

// Create them if not exist
dirs.forEach((dir) => {
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

// Helper function
function ensureDirectoryExists(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

// Load templates from file
function loadTemplates() {
  ensureDirectoryExists("data");
  try {
    if (fs.existsSync("data/templates.json")) {
      return JSON.parse(fs.readFileSync("data/templates.json", "utf-8"));
    }
  } catch (err) {
    console.error("Error loading templates:", err);
  }
  return [];
}

// Save templates to file
function saveTemplates(templates) {
  ensureDirectoryExists("data");
  fs.writeFileSync("data/templates.json", JSON.stringify(templates, null, 2));
}

// WhatsApp Client Manager
class WhatsAppManager {
  constructor() {
    this.clients = new Map();
    this.activeAccount = "default";
    this.eventStreams = new Map();
  }

  async initializeClient(accountId) {
    if (this.clients.has(accountId)) {
      console.log(`Client for ${accountId} already exists`);
      return this.clients.get(accountId);
    }

    const sessionPath = path.join(SESSIONS_DIR, accountId);
    if (!fs.existsSync(sessionPath))
      fs.mkdirSync(sessionPath, { recursive: true });

    console.log(`Initializing client for account ${accountId}`);

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: accountId,
        dataPath: sessionPath,
      }),
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

    this.clients.set(accountId, client);
    this.setupEventHandlers(client, accountId);

    try {
      await client.initialize();
      console.log(`Client initialized for ${accountId}`);
      return client;
    } catch (err) {
      console.error(`Failed to initialize client for ${accountId}:`, err);
      throw err;
    }
  }

  setupEventHandlers(client, accountId) {
    client.on("qr", async (qr) => {
      console.log("QR RECEIVED", qr);
      try {
        const qrImage = await qrcode.toDataURL(qr);
        this.emitEvent(accountId, "qr", { qr: qrImage });
      } catch (err) {
        console.error("QR generation error:", err);
        this.emitEvent(accountId, "error", {
          message: "Failed to generate QR code",
        });
      }
    });

    client.on("ready", () => {
      console.log("Client is ready!");
      this.emitEvent(accountId, "ready", {});
      this.emitEvent(accountId, "status", {
        message: "WhatsApp client is ready!",
      });
    });

    client.on("authenticated", () => {
      console.log("Authenticated!");
      this.emitEvent(accountId, "authenticated", {});
      this.emitEvent(accountId, "status", {
        message: "Successfully authenticated!",
      });
    });

    client.on("auth_failure", (msg) => {
      console.log("Authentication failure:", msg);
      this.emitEvent(accountId, "auth_failure", { msg });
      this.emitEvent(accountId, "status", {
        message: `Authentication failed: ${msg}`,
      });
    });

    client.on("disconnected", (reason) => {
      console.log("Disconnected:", reason);
      this.emitEvent(accountId, "disconnected", { reason });
      this.emitEvent(accountId, "status", {
        message: `Client disconnected: ${reason}`,
      });
    });

    client.on("loading_screen", (percent, message) => {
      console.log(`Loading: ${percent}% - ${message}`);
      this.emitEvent(accountId, "loading", { percent, message });
    });

    client.on("message", (msg) => {
      this.emitEvent(accountId, "message", {
        from: msg.from,
        body: msg.body,
        timestamp: msg.timestamp,
        isMedia: msg.hasMedia,
        type: msg.type,
      });
    });
  }

  emitEvent(accountId, event, data) {
    console.log(`Emitting event ${event} for ${accountId}`);
    if (this.eventStreams.has(accountId)) {
      const res = this.eventStreams.get(accountId);
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        console.error("Error writing to event stream:", err);
        this.eventStreams.delete(accountId);
      }
    }
    this.logEvent(accountId, event, data);
  }

  logEvent(accountId, event, data) {
    const logFile = path.join(LOGS_DIR, `${accountId}.log`);
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${event}: ${JSON.stringify(data)}\n`;
    fs.appendFileSync(logFile, logEntry, { flag: "a" });
  }

  createEventStream(accountId, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send initial connection message
    res.write(
      `event: connected\ndata: ${JSON.stringify({
        message: "SSE Connected",
      })}\n\n`
    );

    this.eventStreams.set(accountId, res);

    res.on("close", () => {
      console.log(`SSE connection closed for ${accountId}`);
      this.eventStreams.delete(accountId);
      res.end();
    });
  }

  async logout(accountId) {
    const client = this.clients.get(accountId);
    if (client) {
      try {
        await client.logout();
        await client.destroy();
        this.clients.delete(accountId);

        const sessionPath = path.join(SESSIONS_DIR, accountId);
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        console.log(`Successfully logged out ${accountId}`);
      } catch (err) {
        console.error(`Error logging out ${accountId}:`, err);
        throw err;
      }
    }
  }
}

const whatsappManager = new WhatsAppManager();

// Initialize default client
whatsappManager.initializeClient("default").catch((err) => {
  console.error("Failed to initialize default client:", err);
});

// API Routes
app.get("/api/accounts", async (req, res) => {
  try {
    const accounts = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/accounts", async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) {
      return res
        .status(400)
        .json({ success: false, error: "Account ID is required" });
    }

    await whatsappManager.initializeClient(accountId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/accounts/activate", async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) {
      return res
        .status(400)
        .json({ success: false, error: "Account ID is required" });
    }

    await whatsappManager.initializeClient(accountId);
    whatsappManager.activeAccount = accountId;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/accounts/logout", async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) {
      return res
        .status(400)
        .json({ success: false, error: "Account ID is required" });
    }

    await whatsappManager.logout(accountId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/accounts/:accountId/events", (req, res) => {
  const { accountId } = req.params;
  whatsappManager.createEventStream(accountId, res);
});

// Send message
app.post("/api/send-message", async (req, res) => {
  let { phone, message, media, accountId = "default" } = req.body;

  // Ensure phone is a string
  phone = String(phone || "");

  if (!phone) {
    return res
      .status(400)
      .json({ success: false, error: "Phone number is required" });
  }

  if (!message && !media?.url) {
    return res
      .status(400)
      .json({ success: false, error: "Either message or media is required" });
  }

  const client = whatsappManager.clients.get(accountId);
  if (!client) {
    return res.status(400).json({
      success: false,
      error: `WhatsApp client for account ${accountId} not initialized`,
    });
  }

  try {
    // Format phone number (remove any non-digit characters)
    let formattedPhone = phone.replace(/\D/g, "");

    // Validate phone number
    if (formattedPhone.length < 10) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid phone number" });
    }

    // Add country code if missing (example for India)
    if (!formattedPhone.startsWith("91") && formattedPhone.length >= 10) {
      formattedPhone = "91" + formattedPhone;
    }

    formattedPhone = formattedPhone + "@c.us";

    let response;

    if (media?.url) {
      // Send media message
      const mediaPath = path.join(__dirname, media.url);
      if (!fs.existsSync(mediaPath)) {
        return res.status(400).json({
          success: false,
          error: "Media file not found",
        });
      }
      const mediaFile = await MessageMedia.fromFilePath(mediaPath);
      response = await client.sendMessage(formattedPhone, mediaFile, {
        caption: message || media.caption || "",
      });
    } else {
      // Send text message
      response = await client.sendMessage(formattedPhone, message);
    }

    res.json({ success: true, message: "Message sent", response });
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// File upload
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: "No file uploaded" });
  }

  try {
    // Move the file from temp uploads to a permanent location
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

// Get all templates
app.get("/api/templates", (req, res) => {
  const templates = loadTemplates();
  res.json({ success: true, templates });
});

// Create new template
app.post("/api/templates", (req, res) => {
  const { name, content } = req.body;

  if (!name || !content) {
    return res
      .status(400)
      .json({ success: false, error: "Both name and content are required" });
  }

  const templates = loadTemplates();
  const newTemplate = {
    id: Date.now().toString(),
    name,
    content,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  templates.push(newTemplate);
  saveTemplates(templates);

  res.json({ success: true, template: newTemplate });
});

// Update template
app.put("/api/templates/:id", (req, res) => {
  const { id } = req.params;
  const { name, content } = req.body;

  if (!name || !content) {
    return res
      .status(400)
      .json({ success: false, error: "Both name and content are required" });
  }

  const templates = loadTemplates();
  const templateIndex = templates.findIndex((t) => t.id === id);

  if (templateIndex === -1) {
    return res
      .status(404)
      .json({ success: false, error: "Template not found" });
  }

  templates[templateIndex] = {
    ...templates[templateIndex],
    name,
    content,
    updatedAt: new Date().toISOString(),
  };

  saveTemplates(templates);

  res.json({ success: true, template: templates[templateIndex] });
});

// Delete template
app.delete("/api/templates/:id", (req, res) => {
  const { id } = req.params;

  const templates = loadTemplates();
  const filteredTemplates = templates.filter((t) => t.id !== id);

  if (filteredTemplates.length === templates.length) {
    return res
      .status(404)
      .json({ success: false, error: "Template not found" });
  }

  saveTemplates(filteredTemplates);

  res.json({ success: true, message: "Template deleted" });
});

// Serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Sessions directory: ${SESSIONS_DIR}`);
  console.log(`Uploads directory: ${UPLOADS_DIR}`);
  console.log(`Logs directory: ${LOGS_DIR}`);
});
