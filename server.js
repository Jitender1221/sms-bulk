require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

// WhatsApp & QR Code dependencies
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;

// Body parser & static
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// MongoDB setup
mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/whatsapp_tool", {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Account Schema
const accountSchema = new mongoose.Schema({
    accountId: { type: String, required: true, unique: true },
    status: { type: String, default: "initialized" },
    lastActivity: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
});
const Account = mongoose.model("Account", accountSchema);

// Message Template Schema
const templateSchema = new mongoose.Schema({
    name: { type: String, required: true },
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});
const Template = mongoose.model("Template", templateSchema);

// Ensure required directories exist
["./sessions", "./uploads", "./data", "./.wwebjs_auth"].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Session setup
app.use(
    session({
        secret: process.env.SESSION_SECRET || "secure_secret",
        resave: false,
        saveUninitialized: true,
        cookie: { secure: false },
    })
);

// In-memory WhatsApp and SSE clients
const whatsappClients = {};
const sseClients = {};

// --- Utility: Broadcast SSE ---
function broadcast(accountId, type, data) {
    if (!sseClients[accountId]) return;
    sseClients[accountId].forEach((c) => {
        try {
            c.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
            // Clean up dead SSE connection
            sseClients[accountId] = sseClients[accountId].filter((x) => x.id !== c.id);
        }
    });
}

// --- WhatsApp Client Initialization ---
function initializeWhatsAppClient(accountId) {
    if (whatsappClients[accountId]) {
        if (whatsappClients[accountId].isReady) {
            broadcast(accountId, "ready", { message: "✅ Already connected" });
            return whatsappClients[accountId];
        }
        return whatsappClients[accountId];
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: accountId }),
        puppeteer: {
            headless: "new",
            args: [ "--no-sandbox" ], // minimal for speed
        },
        // Optional: Use a local cache for WA web version for even quicker boot
        // webVersionCache: { type: "local", location: path.join(__dirname, ".wwebjs_cache") }
    });

    client.isReady = false;
    client.accountId = accountId;
    whatsappClients[accountId] = client;

    // --- WhatsApp Event Handlers ---
    client.on("qr", async (qr) => {
        const qrImage = await qrcode.toDataURL(qr, { errorCorrectionLevel: "L", type: "image/png" });
        broadcast(accountId, "qr", { qr: qrImage });
    });

    client.on("authenticated", async () => {
        broadcast(accountId, "authenticated", { message: "Authenticated, please wait..." });
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

    client.initialize();

    return client;
}

// --- SSE Account Event Stream ---
app.get("/api/accounts/:accountId/events", (req, res) => {
    const { accountId } = req.params;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const clientId = Date.now();
    if (!sseClients[accountId]) sseClients[accountId] = [];
    sseClients[accountId].push({ id: clientId, res });

    res.write(`event: connected\ndata: ${JSON.stringify({ message: "Connected to SSE" })}\n\n`);

    initializeWhatsAppClient(accountId);

    req.on("close", () => {
        sseClients[accountId] = sseClients[accountId].filter((x) => x.id !== clientId);
    });
});

// --- REST Endpoints ---

// Health check
app.get("/api/health", (_req, res) => res.json({ success: true, message: "Server is running" }));

// Get accounts
app.get("/api/accounts", async (_req, res) => {
    try {
        const accounts = await Account.find().sort({ createdAt: -1 });
        res.json({ success: true, accounts });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Create account
app.post("/api/accounts", async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ success: false, error: "Account ID required" });
    if (/\s/.test(accountId)) return res.status(400).json({ success: false, error: "No spaces allowed" });

    try {
        if (await Account.findOne({ accountId }))
            return res.status(400).json({ success: false, error: "Account already exists" });

        const newAccount = new Account({ accountId });
        await newAccount.save();
        res.json({ success: true, account: newAccount });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Activate WhatsApp client for account
app.post("/api/accounts/activate", (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ success: false, error: "Account ID required" });
    initializeWhatsAppClient(accountId);
    res.json({ success: true, message: `Account ${accountId} activated` });
});

// Logout (destroy) WhatsApp client for account
app.post("/api/accounts/logout", async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ success: false, error: "Account ID required" });

    if (whatsappClients[accountId]) {
        try {
            await whatsappClients[accountId].destroy();
            delete whatsappClients[accountId];
            const authDir = path.join(__dirname, ".wwebjs_auth", `session-${accountId}`);
            if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
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

// Refresh QR code: force re-auth
app.post("/api/accounts/:accountId/refresh", (req, res) => {
    const { accountId } = req.params;
    if (!whatsappClients[accountId]) {
        return res.status(400).json({ success: false, error: "Client not initialized" });
    }
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
});

// Message send endpoint (expand as needed, not implemented in this minimal code yet)
app.post("/api/send-message", async (req, res) => {
    let { phone, message, accountId = "default" } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: "Phone number is required" });
    if (!message) return res.status(400).json({ success: false, error: "Message is required" });
    const client = whatsappClients[accountId];
    if (!client) return res.status(400).json({ success: false, error: `Client for ${accountId} not initialized. Please scan the QR code first.` });
    try {
        let formattedPhone = String(phone).replace(/\D/g, "") + "@c.us";
        await client.sendMessage(formattedPhone, message);
        res.json({ success: true, message: `Message sent to ${phone}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get message templates
app.get("/api/templates", async (_req, res) => {
    try {
        const templates = await Template.find().sort({ createdAt: -1 });
        res.json({ success: true, templates });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Create message template
app.post("/api/templates", async (req, res) => {
    const { name, content } = req.body;
    if (!name || !content) return res.status(400).json({ success: false, error: "Name and content required" });
    try {
        const newTemplate = new Template({ name, content });
        await newTemplate.save();
        res.json({ success: true, template: newTemplate });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update template
app.put("/api/templates/:id", async (req, res) => {
    const { id } = req.params;
    const { name, content } = req.body;
    if (!name || !content) return res.status(400).json({ success: false, error: "Name and content required" });
    try {
        const updated = await Template.findByIdAndUpdate(
            id,
            { name, content, updatedAt: new Date() },
            { new: true }
        );
        if (!updated) return res.status(404).json({ success: false, error: "Template not found" });
        res.json({ success: true, template: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Delete template
app.delete("/api/templates/:id", async (req, res) => {
    try {
        const deleted = await Template.findByIdAndDelete(req.params.id);
        if (!deleted) return res.status(404).json({ success: false, error: "Template not found" });
        res.json({ success: true, message: "Template deleted" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Frontend (optional: serve SPA)
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Error handler
app.use((err, req, res, next) => {
    console.error("Server error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
});

// Optionally, auto-initialize a default WhatsApp client
initializeWhatsAppClient("default");

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 WhatsApp Web Client available at http://localhost:${PORT}`);
});
