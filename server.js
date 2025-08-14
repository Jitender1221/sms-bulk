const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");
const multer = require("multer");

const app = express();

// === Middleware ===
app.use(cors());
app.use(bodyParser.json());

// === Serve static frontend ===
app.use(express.static(path.join(__dirname, "public"))); // index.html will be here

// === Setup directories ===
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

const logPath = path.join(__dirname, "logs");
if (!fs.existsSync(logPath)) fs.mkdirSync(logPath);

const logFile = path.join(logPath, "success.log");

// === Multer storage ===
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + "-" + uniqueSuffix + ext);
  },
});
const upload = multer({ storage });

// === WhatsApp Client ===
let qrImageBase64 = null;
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
});

client.on("qr", async (qr) => {
  console.log("🔁 Scan QR to login");
  qrImageBase64 = await qrcode.toDataURL(qr);
});

client.on("ready", () => {
  console.log("✅ WhatsApp client ready!");
  qrImageBase64 = null;
  isReady = true;
});

client.on("auth_failure", (msg) => console.error("❌ Auth failure:", msg));

client.on("disconnected", (reason) => {
  console.warn("⚠️ Disconnected:", reason);
  isReady = false;
  setTimeout(() => client.initialize(), 5000); // Auto-reconnect after 5s
});

client.initialize();

// === API to get QR code ===
app.get("/get-qr", (req, res) => {
  res.json({ qr: qrImageBase64 || null });
});

// === Logging function ===
function logMessage(phone, message) {
  const logEntry = `${new Date().toISOString()} | ${phone} | ${message}\n`;
  fs.appendFile(logFile, logEntry, (err) => {
    if (err) console.error("❌ Error writing log:", err);
  });
}

// === Send helper ===
async function sendMessageOrMedia(phone, message, media) {
  phone = phone.replace(/\D/g, "");
  if (!phone.startsWith("91")) phone = "91" + phone;

  const numberDetails = await client.getNumberId(phone);
  if (!numberDetails) {
    logMessage(phone, "❌ Not on WhatsApp");
    return { skipped: true, reason: "Not on WhatsApp" };
  }

  const chatId = numberDetails._serialized;
  let mediaData;

  if (media?.url) {
    if (media.url.startsWith("http")) {
      const response = await axios.get(media.url, {
        responseType: "arraybuffer",
      });
      const mimeType =
        response.headers["content-type"] || "application/octet-stream";
      const fileName = path.basename(media.url.split("?")[0]);
      mediaData = new MessageMedia(
        mimeType,
        Buffer.from(response.data).toString("base64"),
        fileName
      );
    } else {
      const localPath = path.join(__dirname, media.url.replace(/^\/+/, ""));
      if (!fs.existsSync(localPath)) throw new Error("Media not found");
      const mimeType = mime.lookup(localPath) || "application/octet-stream";
      const buffer = fs.readFileSync(localPath);
      mediaData = new MessageMedia(
        mimeType,
        buffer.toString("base64"),
        path.basename(localPath)
      );
    }
  }

  if (mediaData) {
    await client.sendMessage(chatId, mediaData, {
      caption: media.caption || message,
    });
    logMessage(phone, `[MEDIA] ${media.caption || message}`);
  } else if (message) {
    await client.sendMessage(chatId, message);
    logMessage(phone, message);
  }
  return { skipped: false };
}

// === Single send endpoint ===
app.post("/send-message", async (req, res) => {
  if (!isReady)
    return res.status(503).json({ error: "WhatsApp client not ready" });

  try {
    const result = await sendMessageOrMedia(
      req.body.phone,
      req.body.message,
      req.body.media
    );
    if (result.skipped) {
      return res.json({ success: false, message: result.reason });
    }
    res.json({ success: true, message: `Message sent to ${req.body.phone}` });
  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Bulk send endpoint ===
app.post("/send-messages", async (req, res) => {
  if (!isReady)
    return res.status(503).json({ error: "WhatsApp client not ready" });

  const messages = req.body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "No messages provided" });
  }

  const concurrency = 5;
  let results = [];
  let idx = 0;

  async function sendNext() {
    if (idx >= messages.length) return;
    const { phone, message, media } = messages[idx++];
    try {
      const result = await sendMessageOrMedia(phone, message, media);
      results.push({
        phone,
        success: !result.skipped,
        skipped: result.skipped,
        error: result.reason || null,
      });
    } catch (err) {
      results.push({
        phone,
        success: false,
        skipped: false,
        error: err.message,
      });
    }
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
    return sendNext();
  }

  await Promise.all(Array(concurrency).fill(0).map(sendNext));
  res.json({ results });
});

// === Download logs ===
app.get("/download-log", (req, res) => {
  if (!fs.existsSync(logFile))
    return res.status(404).send("Log file not found");
  res.download(logFile, "whatsapp_success_log.txt");
});

// === Upload endpoint ===
app.post("/upload-media", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.use("/uploads", express.static(uploadPath));

// === Fallback: serve index.html for any unknown route ===
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
