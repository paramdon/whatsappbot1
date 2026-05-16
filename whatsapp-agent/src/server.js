// src/server.js
// Main entry point

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const { initAI } = require('./services/aiService');
const wa = require('./services/whatsappManager');
const { startScheduler } = require('./services/scheduler');
const adminRoutes = require('./routes/admin');
const dashboardRoutes = require('./routes/dashboard');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── Session ───────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'wa-agent-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── Routes ────────────────────────────────────────────────────────
app.use('/admin', adminRoutes);
app.use('/dashboard', dashboardRoutes);

// ── Health / Keep-alive ping ──────────────────────────────────────
app.get('/ping', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.redirect('/dashboard/login'));

// ── Socket.IO ─────────────────────────────────────────────────────
wa.setIO(io);
io.on('connection', (socket) => {
  console.log('[WS] Client connected');
});

// ── Startup ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`\n🚀 WhatsApp Agent Server running on port ${PORT}`);
  console.log(`📊 Admin panel: http://localhost:${PORT}/admin/dashboard`);
  console.log(`👤 Client panel: http://localhost:${PORT}/dashboard/login`);

  // Init AI
  initAI();
  console.log('[AI] AI services initialized');

  // Start scheduler
  startScheduler();

  // Restore WhatsApp sessions (delay to let server settle)
  setTimeout(async () => {
    try {
      await wa.initAllSessions();
    } catch (e) {
      console.error('[WA] Session init error:', e.message);
    }
  }, 3000);
});

process.on('uncaughtException', (err) => {
  console.error('[CRASH] Uncaught exception:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('[CRASH] Unhandled rejection:', err?.message);
});
