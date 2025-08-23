/************ server.js ************/
require('dotenv').config();
const express       = require('express');
const session       = require('express-session');
const FileStore     = require('session-file-store')(session);
const path          = require('path');
const fs            = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode        = require('qrcode');
const cors          = require('cors');
const bodyParser    = require('body-parser');
const mongoose      = require('mongoose');
const fileUpload    = require('express-fileupload');

process.setMaxListeners(20);

const app   = express();
const PORT  = process.env.PORT || 3000;

/* ---------- Mongoose Models ---------- */
const accountSchema = new mongoose.Schema({
  accountId : { type: String, required: true, unique: true },
  status    : { type: String, default: 'initialized' },
  lastActivity : { type: Date, default: Date.now },
  createdAt : { type: Date, default: Date.now },
});
const templateSchema = new mongoose.Schema({
  name      : { type: String, required: true },
  content   : { type: String, required: true },
  createdAt : { type: Date, default: Date.now },
  updatedAt : { type: Date, default: Date.now },
});
const messageSchema = new mongoose.Schema({
  accountId : { type: String, required: true },
  phone     : { type: String, required: true },
  message   : String,
  media     : Object,
  status    : { type: String, default: 'sending' },
  error     : String,
  messageId : String,
  createdAt : { type: Date, default: Date.now },
});

const Account  = mongoose.model('Account', accountSchema);
const Template = mongoose.model('Template', templateSchema);
const Message  = mongoose.model('Message', messageSchema);

/* ---------- Middleware ---------- */
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(fileUpload());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* ---------- Required dirs ---------- */
['./sessions', './uploads', './data', './.wwebjs_auth'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(session({
  store: new FileStore({ path: './sessions' }),
  secret: process.env.SESSION_SECRET || 'jitender@123',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false },
}));

/* ---------- WhatsApp & SSE Maps ---------- */
const whatsappClients = {};
const sseClients      = {};

/* ---------- Helpers ---------- */
function broadcastEvent(accountId, type, data) {
  const clients = sseClients[accountId];
  if (!clients) return;
  clients.forEach(c => {
    try {
      c.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // remove dead client
      sseClients[accountId] = clients.filter(x => x.id !== c.id);
    }
  });
}

/* ---------- WhatsApp Client Init ---------- */
function initClient(accountId) {
  if (whatsappClients[accountId]) return whatsappClients[accountId];

  const client = new Client({
    authStrategy : new LocalAuth({ clientId: accountId }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
             '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
             '--disable-gpu', '--single-process'],
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
  });

  client.isReady = false;
  client.accountId = accountId;

  client.on('qr', async qr => {
    const qrImage = await qrcode.toDataURL(qr);
    broadcastEvent(accountId, 'qr', { qr: qrImage });
  });
  client.on('authenticated', async () => {
    await Account.findOneAndUpdate({ accountId }, { status: 'authenticated', lastActivity: new Date() }, { upsert: true });
    broadcastEvent(accountId, 'authenticated', { message: 'Authenticated, please wait...' });
  });
  client.on('ready', async () => {
    client.isReady = true;
    await Account.findOneAndUpdate({ accountId }, { status: 'ready', lastActivity: new Date() }, { upsert: true });
    broadcastEvent(accountId, 'ready', { message: '✅ Connected and ready' });
  });
  client.on('auth_failure', async msg => {
    await Account.findOneAndUpdate({ accountId }, { status: 'auth_failure', lastActivity: new Date() });
    broadcastEvent(accountId, 'auth_failure', { msg });
  });
  client.on('disconnected', async reason => {
    client.isReady = false;
    delete whatsappClients[accountId];
    await Account.findOneAndUpdate({ accountId }, { status: 'disconnected', lastActivity: new Date() });
    broadcastEvent(accountId, 'disconnected', { reason });
  });

  client.initialize().catch(err => {
    console.error(`Client ${accountId} init error:`, err);
    broadcastEvent(accountId, 'error', { message: err.message });
  });

  whatsappClients[accountId] = client;
  return client;
}

/* ---------- Routes ---------- */
app.get('/api/health', (_, res) => res.json({ success: true }));

app.get('/api/accounts', async (_, res) => {
  try {
    const accounts = await Account.find().sort({ createdAt: -1 });
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts', async (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ success: false, error: 'Account ID required' });
  if (accountId.includes(' ')) return res.status(400).json({ success: false, error: 'No spaces allowed' });

  try {
    const exists = await Account.findOne({ accountId });
    if (exists) return res.status(400).json({ success: false, error: 'Account already exists' });

    const acc = new Account({ accountId });
    await acc.save();
    initClient(accountId);
    res.json({ success: true, message: `Account ${accountId} created`, account: acc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/activate', (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ success: false, error: 'Account ID required' });
  initClient(accountId);
  res.json({ success: true, message: `Account ${accountId} activated` });
});

app.post('/api/accounts/logout', async (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ success: false, error: 'Account ID required' });

  try {
    const client = whatsappClients[accountId];
    if (client) {
      await client.destroy();
      delete whatsappClients[accountId];
      const authDir = path.join(__dirname, '.wwebjs_auth', `session-${accountId}`);
      if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    }
    await Account.findOneAndUpdate({ accountId }, { status: 'disconnected', lastActivity: new Date() });
    res.json({ success: true, message: `Account ${accountId} logged out` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- SSE Endpoint ---------- */
app.get('/api/accounts/:accountId/events', (req, res) => {
  const { accountId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const id = Date.now();
  if (!sseClients[accountId]) sseClients[accountId] = [];
  sseClients[accountId].push({ id, res });

  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to SSE' })}\n\n`);
  initClient(accountId);

  req.on('close', () => {
    sseClients[accountId] = (sseClients[accountId] || []).filter(c => c.id !== id);
  });
});

/* ---------- Send Message ---------- */
app.post('/api/send-message', async (req, res) => {
  let { phone, message, media, accountId = 'default' } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });
  if (!message && !media?.url) return res.status(400).json({ success: false, error: 'Message or media required' });

  const client = whatsappClients[accountId];
  if (!client || !client.isReady) {
    return res.status(400).json({ success: false, error: 'Client not ready – scan QR first' });
  }

  try {
    let num = String(phone).replace(/\D/g, '');
    if (!num.startsWith('91')) num = '91' + num;
    const chatId = num + '@c.us';

    if (media?.url) {
      const mediaPath = path.join(__dirname, media.url);
      if (!fs.existsSync(mediaPath)) return res.status(400).json({ success: false, error: 'Media not found' });
      const mediaData = MessageMedia.fromFilePath(mediaPath);
      await client.sendMessage(chatId, mediaData, { caption: message || media.caption || '' });
    } else {
      await client.sendMessage(chatId, message);
    }
    res.json({ success: true, message: 'Message sent' });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- File Upload ---------- */
app.post('/api/upload', (req, res) => {
  if (!req.files || !req.files.file) return res.status(400).json({ success: false, error: 'No file' });

  const file = req.files.file;
  const filename = `${Date.now()}-${file.name}`;
  const filepath = path.join(__dirname, 'uploads', filename);

  file.mv(filepath, err => {
    if (err) return res.status(500).json({ success: false, error: 'Upload failed' });
    res.json({ success: true, url: `/uploads/${filename}`, originalName: file.name });
  });
});

/* ---------- Templates CRUD ---------- */
app.get('/api/templates', async (_, res) => {
  try {
    const templates = await Template.find().sort({ createdAt: -1 });
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/templates', async (req, res) => {
  const { name, content } = req.body;
  if (!name || !content) return res.status(400).json({ success: false, error: 'Name & content required' });
  try {
    const template = new Template({ name, content });
    await template.save();
    res.json({ success: true, template });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/templates/:id', async (req, res) => {
  const { id } = req.params;
  const { name, content } = req.body;
  try {
    const t = await Template.findByIdAndUpdate(id, { name, content, updatedAt: new Date() }, { new: true });
    if (!t) return res.status(404).json({ success: false, error: 'Template not found' });
    res.json({ success: true, template: t });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/templates/:id', async (req, res) => {
  try {
    const t = await Template.findByIdAndDelete(req.params.id);
    if (!t) return res.status(404).json({ success: false, error: 'Template not found' });
    res.json({ success: true, message: 'Template deleted' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ---------- Graceful Shutdown ---------- */
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  for (const id in whatsappClients) {
    try { await whatsappClients[id].destroy(); } catch {}
  }
  await mongoose.connection.close();
  process.exit(0);
});

/* ---------- SPA fallback ---------- */
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---------- Global error handler ---------- */
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

/* ---------- Start ---------- */
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/whatsapp_tool')
       .then(() => console.log('✅ MongoDB connected'))
       .catch(err => { console.error('❌ MongoDB error:', err); process.exit(1); });

initClient('default');

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
