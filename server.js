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

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Directories setup
const uploadPath = path.join(__dirname, "uploads");
const logPath = path.join(__dirname, "logs");
const sessionPath = path.join(__dirname, ".wwebjs_auth");

if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);
if (!fs.existsSync(logPath)) fs.mkdirSync(logPath);

const logFile = path.join(logPath, "success.log");

// Multer config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadPath),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + "-" + uniqueSuffix + ext);
    },
});
const upload = multer({ storage });

// WhatsApp Client
let client = null;
let clients = new Set();
let qrGenerated = false;

// Initialize WhatsApp Client with optimized settings
function initClient() {
    if (client) return client;

    console.log("Initializing WhatsApp client...");
    
    client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: "bulk-sender",
            dataPath: sessionPath
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
                "--single-process"
            ],
            executablePath: process.env.CHROME_PATH || undefined
        },
        qrMaxRetries: 3,
        takeoverOnConflict: true,
        restartOnAuthFail: true
    });

    // Optimized QR code generation
    client.on("qr", async (qr) => {
        console.log("QR Code generated");
        qrGenerated = true;
        try {
            const qrImage = await qrcode.toDataURL(qr, { scale: 10 });
            notifyClients({ event: "qr", qr: qrImage });
        } catch (err) {
            console.error("QR generation error:", err);
        }
    });

    client.on("ready", () => {
        console.log("WhatsApp client ready!");
        qrGenerated = false;
        notifyClients({ event: "ready" });
    });

    client.on("authenticated", () => {
        console.log("Authenticated!");
        notifyClients({ event: "authenticated" });
    });

    client.on("auth_failure", (msg) => {
        console.error("Auth failure:", msg);
        notifyClients({ event: "auth_failure", message: msg });
    });

    client.on("disconnected", (reason) => {
        console.warn("Disconnected:", reason);
        notifyClients({ event: "disconnected", reason });
        setTimeout(() => {
            client.initialize().catch(err => console.error("Reinit error:", err));
        }, 2000);
    });

    client.on("loading_screen", (percent, message) => {
        console.log(`Loading: ${percent}% ${message || ""}`);
        notifyClients({ 
            event: "log", 
            message: `Loading: ${percent}% ${message || ""}`,
            timestamp: Date.now()
        });
    });

    // Start with a timeout to prevent hanging
    setTimeout(() => {
        client.initialize().catch(err => {
            console.error("Initialization error:", err);
            notifyClients({ 
                event: "log", 
                message: `Initialization error: ${err.message}`,
                timestamp: Date.now()
            });
        });
    }, 500);

    return client;
}

// SSE for real-time events
function notifyClients(data) {
    const message = `event: ${data.event}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => {
        try {
            client.res.write(message);
        } catch (err) {
            console.error("Error sending SSE:", err);
            clients.delete(client);
        }
    });
}

// Routes
app.get("/events", (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res
    };
    
    clients.add(newClient);
    
    // Send initial status if available
    if (client && client.info) {
        res.write(`event: ready\ndata: {}\n\n`);
    } else if (qrGenerated) {
        // If QR was already generated before this client connected
        qrcode.toDataURL(client.qrCode, { scale: 10 })
            .then(qrImage => {
                res.write(`event: qr\ndata: ${JSON.stringify({ qr: qrImage })}\n\n`);
            })
            .catch(err => console.error("QR regen error:", err));
    }
    
    req.on('close', () => {
        clients.delete(newClient);
    });
});

app.post("/refresh-qr", (req, res) => {
    if (client) {
        client.initialize().catch(err => console.error("Refresh error:", err));
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, error: "Client not initialized" });
    }
});

app.post("/logout", async (req, res) => {
    try {
        if (client) {
            await client.logout();
            await client.destroy();
            client = null;
            
            // Clear session data
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true });
            }
            
            // Reinitialize client
            initClient();
        }
        res.json({ success: true });
    } catch (err) {
        console.error("Logout error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Logging function
function logMessage(phone, message) {
    const logEntry = `${new Date().toISOString()} | ${phone} | ${message}\n`;
    fs.appendFile(logFile, logEntry, (err) => {
        if (err) console.error("Error writing log:", err);
    });
    notifyClients({ 
        event: "log", 
        message: `Message log: ${phone} - ${message}`,
        timestamp: Date.now()
    });
}

// Message sending function
async function sendMessageOrMedia(phone, message, media) {
    phone = phone.replace(/\D/g, "");
    const cc = phone.length <= 10 ? "91" : ""; // Default to India if number is 10 digits
    if (cc && !phone.startsWith(cc)) phone = cc + phone;

    try {
        const numberDetails = await client.getNumberId(phone);
        if (!numberDetails) {
            logMessage(phone, "Not on WhatsApp");
            return { skipped: true, reason: "Not on WhatsApp" };
        }

        const chatId = numberDetails._serialized;
        let mediaData;

        if (media?.url) {
            if (media.url.startsWith("http")) {
                const response = await axios.get(media.url, { 
                    responseType: "arraybuffer",
                    timeout: 10000 
                });
                const mimeType = response.headers["content-type"] || "application/octet-stream";
                const fileName = path.basename(media.url.split("?")[0]);
                mediaData = new MessageMedia(mimeType, Buffer.from(response.data).toString("base64"), fileName);
            } else {
                const localPath = path.join(__dirname, media.url.replace(/^\/+/, ""));
                if (!fs.existsSync(localPath)) throw new Error("Media not found");
                const mimeType = mime.lookup(localPath) || "application/octet-stream";
                const buffer = fs.readFileSync(localPath);
                mediaData = new MessageMedia(mimeType, buffer.toString("base64"), path.basename(localPath));
            }
        }

        if (mediaData) {
            await client.sendMessage(chatId, mediaData, { caption: media.caption || message });
            logMessage(phone, `[MEDIA] ${media.caption || message}`);
        } else {
            await client.sendMessage(chatId, message);
            logMessage(phone, message);
        }
        return { skipped: false };
    } catch (err) {
        console.error("Send message error:", err);
        return { skipped: true, reason: err.message };
    }
}

// API endpoints
app.post("/send-message", async (req, res) => {
    if (!client || !client.info) {
        return res.status(503).json({ error: "WhatsApp client not ready" });
    }

    try {
        const result = await sendMessageOrMedia(req.body.phone, req.body.message, req.body.media);
        if (result.skipped) {
            return res.json({ success: false, message: result.reason });
        }
        res.json({ success: true, message: `Message sent to ${req.body.phone}` });
    } catch (err) {
        console.error("Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/download-log", (req, res) => {
    if (!fs.existsSync(logFile)) return res.status(404).send("Log file not found");
    res.download(logFile, "whatsapp_success_log.txt");
});

app.post("/upload-media", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.json({ url: `/uploads/${req.file.filename}` });
});

app.use("/uploads", express.static(uploadPath));

app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Initialize client
initClient();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    notifyClients({ 
        event: "log", 
        message: `Server started on port ${PORT}`,
        timestamp: Date.now()
    });
});

// Process cleanup
process.on('SIGINT', async () => {
    console.log("Shutting down gracefully...");
    if (client) {
        await client.destroy();
    }
    process.exit();
});
