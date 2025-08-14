// server.js

const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
app.use("/uploads", express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage });

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log("📱 Scan QR Code to login:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("✅ WhatsApp client is ready!");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Auth failed:", msg);
});

client.on("disconnected", (reason) => {
  console.warn("⚠️ Client disconnected:", reason);
  client.destroy().then(() => client.initialize());
});

client.initialize();

app.post("/send-message", async (req, res) => {
  try {
    let { phone, message, media } = req.body;

    if (!phone || !message) {
      return res.status(400).json({
        success: false,
        error: "Phone and message are required",
      });
    }

    phone = phone.replace(/\D/g, "");
    if (!phone.startsWith("91")) phone = "91" + phone;

    const numberDetails = await client.getNumberId(phone);
    if (!numberDetails) {
      return res.status(400).json({
        success: false,
        error: `Number ${phone} is not registered on WhatsApp`,
      });
    }

    const chatId = numberDetails._serialized;
    let mediaMessage;

    if (media && media.url) {
      let mimeType, fileName, base64data;

      if (media.url.startsWith("http")) {
        const response = await axios.get(media.url, {
          responseType: "arraybuffer",
        });
        mimeType = response.headers["content-type"];
        fileName = path.basename(media.url.split("?")[0]);
        base64data = Buffer.from(response.data).toString("base64");
      } else {
        const filePath = path.join(__dirname, media.url.replace(/^\/+/, ""));
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({
            success: false,
            error: "Media file not found: " + media.url,
          });
        }

        const buffer = fs.readFileSync(filePath);
        mimeType = mime.lookup(filePath) || "application/octet-stream";
        fileName = path.basename(filePath);
        base64data = buffer.toString("base64");
      }

      mediaMessage = new MessageMedia(mimeType, base64data, fileName);
      await client.sendMessage(chatId, mediaMessage, {
        caption: media.caption || message,
      });
    } else {
      await client.sendMessage(chatId, message);
    }

    console.log(`✅ Sent to ${phone}`);
    return res.json({ success: true, message: `Message sent to ${phone}` });
  } catch (err) {
    console.error("❌ Send error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: err.message,
    });
  }
});

app.post("/upload-media", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const url = `/uploads/${req.file.filename}`;
  return res.json({ url });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
