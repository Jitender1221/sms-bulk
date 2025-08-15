require("dotenv").config();
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const path = require("path");
// const fs = require("fs");
const multer = require("multer");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const xlsx = require("xlsx");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 3001;

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

const fs = require("fs");
if (!fs.existsSync("sessions")) {
  fs.mkdirSync("sessions");
}

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

// Initialize WhatsApp clients
const whatsappClients = {};
const sseClients = {};

// Helper functions
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

// Get all accounts
function getAccountsList() {
  const accountsDir = path.join(__dirname, ".wwebjs_auth");
  let accounts = ["default"]; // Always include default account

  try {
    if (fs.existsSync(accountsDir)) {
      const files = fs.readdirSync(accountsDir);
      accounts = [
        "default",
        ...files
          .filter((file) => file.endsWith("-session.json"))
          .map((file) => file.replace("-session.json", ""))
          .filter((name) => name !== "default"),
      ];
    }
  } catch (err) {
    console.error("Error reading accounts:", err);
  }

  return [...new Set(accounts)];
}

// Initialize WhatsApp client for an account
function initializeWhatsAppClient(accountId) {
  if (whatsappClients[accountId]) {
    return whatsappClients[accountId];
  }

  console.log(`Initializing WhatsApp client for account: ${accountId}`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: accountId }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  whatsappClients[accountId] = client;

  client.on("qr", async (qr) => {
    console.log(`QR received for ${accountId}`);
    try {
      const qrImage = await qrcode.toDataURL(qr);
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

  client.on("loading_screen", (percent, message) => {
    broadcastEvent(accountId, "loading", { percent, message });
  });

  client.on("message", (msg) => {
    console.log("Received message:", msg.body);
  });

  client.on("error", (err) => {
    console.error(`Client error for ${accountId}:`, err);
    broadcastEvent(accountId, "error", { message: err.message });
  });

  client.initialize().catch((err) => {
    console.error(`Failed to initialize client for ${accountId}:`, err);
  });

  return client;
}

// Broadcast event to all SSE clients for an account
function broadcastEvent(accountId, type, data) {
  if (!sseClients[accountId]) return;

  sseClients[accountId].forEach((client) => {
    try {
      client.res.write(`event: ${type}\n`);
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error("Error sending SSE:", err);
    }
  });
}

// Routes

// Get all accounts
app.get("/api/accounts", (req, res) => {
  const accounts = getAccountsList();
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

  // Initialize the client which will create the session
  initializeWhatsAppClient(accountId);

  // Get updated accounts list
  const accounts = getAccountsList();

  res.json({
    success: true,
    message: `Account ${accountId} initialized`,
    accounts,
  });
});

// Activate account
app.post("/api/accounts/activate", (req, res) => {
  const { accountId } = req.body;

  if (!accountId) {
    return res
      .status(400)
      .json({ success: false, error: "Account ID is required" });
  }

  // Initialize the client if not already done
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

      // Remove session file
      const sessionFile = path.join(
        __dirname,
        ".wwebjs_auth",
        `${accountId}-session.json`
      );
      if (fs.existsSync(sessionFile)) {
        fs.unlinkSync(sessionFile);
      }

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
  const accountId = req.params.accountId;

  // Set headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Create a new client for this connection
  const clientId = Date.now();
  if (!sseClients[accountId]) {
    sseClients[accountId] = [];
  }

  sseClients[accountId].push({
    id: clientId,
    res,
  });

  // Send initial connected event
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ message: "Connected to SSE" })}\n\n`);

  // Initialize the client if not already done
  initializeWhatsAppClient(accountId);

  // Handle client disconnect
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

  const client = whatsappClients[accountId];
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

    // Add country code if missing (example for Brazil)
    if (!formattedPhone.startsWith("55") && formattedPhone.length >= 10) {
      formattedPhone = "55" + formattedPhone;
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
      response = await client.sendMessage(formattedPhone, {
        media: mediaPath,
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

// Template management routes

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
  console.log(`Server running on port ${PORT}`);

  // Create required directories
  ensureDirectoryExists("uploads");
  ensureDirectoryExists("data");
  ensureDirectoryExists(".wwebjs_auth");
  ensureDirectoryExists("sessions");

  // Initialize default client
  initializeWhatsAppClient("default");
});
