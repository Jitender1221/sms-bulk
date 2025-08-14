// server.js - WhatsApp Bulk Sender Backend
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const qrcode = require("qrcode");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const mime = require("mime-types");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public"))); // Serve your HTML & JS

// Folders
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
const LOG_FILE = path.join(logsDir, "bulk_log.txt");

// WhatsApp client & state
let qrCodeImage = null;
let isReady = false;

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "bulk-sender" }),
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
  webVersionCache: { type: "none" }, // Add this line
});

// --- WhatsApp events ---
client.on("qr", async (qr) => {
  if (!isReady) {
    console.log("📲 New QR generated. Waiting for scan...");
    qrCodeImage = await qrcode.toDataURL(qr);
  }
});

client.on("ready", () => {
  console.log("✅ WhatsApp is ready!");
  isReady = true;
  qrCodeImage = null;
});

client.on("authenticated", () => {
  console.log("🔐 Authenticated successfully.");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Authentication failure:", msg);
  isReady = false;
});

client.on("disconnected", (reason) => {
  console.warn("⚠️ Disconnected:", reason);
  isReady = false;
  qrCodeImage = null;
  setTimeout(() => {
    console.log("🔄 Re-initializing WhatsApp client...");
    client.initialize();
  }, 5000);
});

// Init WA
client.initialize();

// --- API Routes ---

// Get QR for login
app.get("/get-qr", (req, res) => {
  if (isReady) {
    return res.json({ status: "already_authenticated" });
  }
  if (qrCodeImage) {
    return res.json({ qr: qrCodeImage });
  }
  res.json({}); // No QR yet, still connecting
});

// Check auth status (frontend polls this)
app.get("/check-auth", (req, res) => {
  res.json({ isReady });
});

// Send one message (used by bulk sender loop in frontend)
app.post("/send-message", async (req, res) => {
  if (!isReady) {
    return res
      .status(503)
      .json({ success: false, message: "Client not ready" });
  }

  let { phone, message, mediaUrl } = req.body;
  if (!phone) {
    return res
      .status(400)
      .json({ success: false, message: "Missing phone number" });
  }

  // Ensure proper WhatsApp chat ID format
  const chatId = phone.includes("@c.us") ? phone : `${phone}@c.us`;

  try {
    if (mediaUrl) {
      const response = await axios.get(mediaUrl, {
        responseType: "arraybuffer",
      });
      const mimeType = mime.lookup(mediaUrl);
      const media = new MessageMedia(
        mimeType,
        Buffer.from(response.data).toString("base64")
      );
      await client.sendMessage(chatId, media, { caption: message || "" });
    } else {
      await client.sendMessage(chatId, message || "");
    }

    fs.appendFileSync(
      LOG_FILE,
      `${new Date().toISOString()} | ${phone} | ${message || "[media]"}\n`
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("Send error:", err);
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Download bulk log
app.get("/download-log", (req, res) => {
  if (fs.existsSync(LOG_FILE)) {
    res.download(LOG_FILE, "whatsapp_bulk_log.txt");
  } else {
    res.status(404).send("No log file found");
  }
});

// Root serve HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
