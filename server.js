// server.js
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const axios = require("axios");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(bodyParser.json());

// ==== Setup directories ====
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);
const logPath = path.join(__dirname, "logs");
if (!fs.existsSync(logPath)) fs.mkdirSync(logPath);
const logFile = path.join(logPath, "success.log");

// ==== Multer ====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// ==== WhatsApp Client ====
let client;
function initClient() {
  client = new Client({
    authStrategy: new LocalAuth({ clientId: "bulk-sender" }),
    puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] }
  });

  client.on("qr", (qr) => {
    console.log("QR code generated");
    io.emit("qr", qr);
  });

  client.on("ready", () => {
    console.log("✅ WhatsApp is ready");
    io.emit("ready", true);
  });

  client.on("disconnected", () => {
    console.log("❌ Disconnected, reinitializing...");
    io.emit("disconnected", true);
    initClient();
    client.initialize();
  });

  client.initialize();
}
initClient();

// ==== Logging ====
function logMessage(phone, message) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} | ${phone} | ${message}\n`);
}

// ==== Message Sender ====
async function sendMessageOrMedia(phone, message, media) {
  phone = phone.replace(/\D/g, "");
  if (!phone.startsWith("91")) phone = "91" + phone;
  const numberDetails = await client.getNumberId(phone);
  if (!numberDetails) throw new Error(`Phone ${phone} not on WhatsApp`);
  const chatId = numberDetails._serialized;

  let mediaData;
  if (media?.url) {
    if (media.url.startsWith("http")) {
      const resp = await axios.get(media.url, { responseType: "arraybuffer" });
      mediaData = new MessageMedia(resp.headers["content-type"], Buffer.from(resp.data).toString("base64"), path.basename(media.url));
    } else {
      const localPath = path.join(__dirname, media.url.replace(/^\/+/, ""));
      if (!fs.existsSync(localPath)) throw new Error("Media not found");
      const buffer = fs.readFileSync(localPath);
      mediaData = new MessageMedia(mime.lookup(localPath) || "application/octet-stream", buffer.toString("base64"), path.basename(localPath));
    }
  }

  if (mediaData) {
    await client.sendMessage(chatId, mediaData, { caption: message });
  } else {
    await client.sendMessage(chatId, message);
  }
  logMessage(phone, message);
}

// ==== Endpoints ====

// Send single
app.post("/send-message", async (req, res) => {
  try {
    await sendMessageOrMedia(req.body.phone, req.body.message, req.body.media);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Download log
app.get("/download-log", (req, res) => {
  if (!fs.existsSync(logFile)) return res.status(404).send("Log file not found");
  res.download(logFile);
});

// Upload media
app.post("/upload-media", upload.single("file"), (req, res) => {
  res.json({ url: `/uploads/${req.file.filename}` });
});
app.use("/uploads", express.static(uploadPath));

// Logout button
app.get("/logout", async (req, res) => {
  try {
    await client.logout();
    io.emit("logout", true);
    res.json({ success: true, message: "Logged out" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

server.listen(3000, () => console.log("🚀 Server running on http://localhost:3000"));
