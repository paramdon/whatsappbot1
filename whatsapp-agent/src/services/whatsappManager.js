// src/services/whatsappManager.js
// Manages one WhatsApp-web.js client per business client

const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer-core');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { handleMessage } = require('../agent/appointmentAgent');

const sessions = {}; // clientId -> { client, qr, status, io }
let _io = null; // socket.io instance

function setIO(io) { _io = io; }

// ════════════════════════════════════════════════════════════════════
// INIT / RESTORE SESSIONS
// ════════════════════════════════════════════════════════════════════

async function initAllSessions() {
  const clients = db.getAllClients().filter(c => c.status === 'active');
  console.log(`[WA] Restoring ${clients.length} active sessions...`);
  for (const client of clients) {
    await startSession(client.id);
    await sleep(2000); // stagger init to avoid memory spike
  }
}

async function startSession(clientId) {
  if (sessions[clientId] && sessions[clientId].status === 'ready') {
    console.log(`[WA] Session ${clientId} already ready.`);
    return;
  }

  const client = db.getClient(clientId);
  if (!client) return;

  console.log(`[WA] Starting session for: ${client.businessName} (${clientId})`);

  const sessionDir = path.join(__dirname, '../../data/sessions', clientId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const waClient = new Client({
    authStrategy: new LocalAuth({ clientId, dataPath: path.join(__dirname, '../../data/sessions') }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
     ]
   },
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' }
  });

  sessions[clientId] = { client: waClient, qr: null, status: 'initializing', qrBase64: null };

  // ── QR Code ───────────────────────────────────────────────────
  waClient.on('qr', async (qr) => {
    console.log(`[WA] QR received for ${clientId}`);
    sessions[clientId].qr = qr;
    sessions[clientId].status = 'qr_pending';
    try {
      sessions[clientId].qrBase64 = await qrcode.toDataURL(qr);
    } catch (e) {}
    emitToAdmin('qr_update', { clientId, qrBase64: sessions[clientId].qrBase64, status: 'qr_pending' });
  });

  // ── Ready ──────────────────────────────────────────────────────
  waClient.on('ready', () => {
    console.log(`[WA] ✅ Ready: ${client.businessName}`);
    sessions[clientId].status = 'ready';
    sessions[clientId].qr = null;
    sessions[clientId].qrBase64 = null;
    db.updateClient(clientId, { sessionConnected: true, lastSeen: new Date().toISOString() });
    emitToAdmin('status_update', { clientId, status: 'ready' });
  });

  // ── Authenticated ─────────────────────────────────────────────
  waClient.on('authenticated', () => {
    sessions[clientId].status = 'authenticated';
    emitToAdmin('status_update', { clientId, status: 'authenticated' });
  });

  // ── Auth failure ──────────────────────────────────────────────
  waClient.on('auth_failure', () => {
    console.log(`[WA] Auth failure for ${clientId}`);
    sessions[clientId].status = 'auth_failed';
    db.updateClient(clientId, { sessionConnected: false });
    emitToAdmin('status_update', { clientId, status: 'auth_failed' });
  });

  // ── Disconnected ──────────────────────────────────────────────
  waClient.on('disconnected', async (reason) => {
    console.log(`[WA] Disconnected: ${clientId} — ${reason}`);
    sessions[clientId].status = 'disconnected';
    db.updateClient(clientId, { sessionConnected: false });
    emitToAdmin('status_update', { clientId, status: 'disconnected' });

    // Auto-reconnect after 30s
    setTimeout(() => {
      if (db.isClientActive(clientId)) {
        console.log(`[WA] Auto-reconnecting: ${clientId}`);
        startSession(clientId);
      }
    }, 30000);
  });

  // ── Incoming message ──────────────────────────────────────────
  waClient.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;
      if (msg.from.includes('@g.us')) return; // skip group messages
      if (msg.type !== 'chat') return; // skip media for now

      const userPhone = msg.from;
      const messageText = msg.body.trim();
      if (!messageText) return;

      // Check expiry
      if (!db.isClientActive(clientId)) {
        await msg.reply('⚠️ This service is currently unavailable.');
        return;
      }

      const contact = await msg.getContact();
      const userName = contact.pushname || contact.name || 'Customer';

      console.log(`[MSG] ${clientId} <- ${userPhone}: ${messageText.slice(0, 60)}`);

      const response = await handleMessage(clientId, userPhone, userName, messageText);

      if (response) {
        await msg.reply(response);
        console.log(`[MSG] ${clientId} -> ${userPhone}: ${response.slice(0, 60)}...`);
      }

      // Emit to dashboard for live monitoring
      emitToAdmin('new_message', {
        clientId,
        from: userPhone,
        name: userName,
        message: messageText,
        response: response || '(no reply)',
        timestamp: new Date().toISOString()
      });

    } catch (err) {
      console.error(`[WA] Message handler error for ${clientId}:`, err.message);
    }
  });

  await waClient.initialize();
}

async function stopSession(clientId) {
  if (sessions[clientId] && sessions[clientId].client) {
    try {
      await sessions[clientId].client.destroy();
    } catch (e) {}
  }
  sessions[clientId] = { status: 'stopped', qr: null, qrBase64: null };
  db.updateClient(clientId, { sessionConnected: false });
}

async function restartSession(clientId) {
  await stopSession(clientId);
  await sleep(3000);
  await startSession(clientId);
}

function getSessionStatus(clientId) {
  return sessions[clientId] ? sessions[clientId].status : 'not_started';
}

function getSessionQR(clientId) {
  return sessions[clientId] ? sessions[clientId].qrBase64 : null;
}

function getAllSessionStatuses() {
  const result = {};
  for (const [id, s] of Object.entries(sessions)) {
    result[id] = { status: s.status, hasQR: !!s.qrBase64 };
  }
  return result;
}

async function sendMessage(clientId, toPhone, message) {
  const s = sessions[clientId];
  if (!s || s.status !== 'ready') return false;
  try {
    const phone = toPhone.includes('@c.us') ? toPhone : `${toPhone}@c.us`;
    await s.client.sendMessage(phone, message);
    return true;
  } catch (e) {
    console.error(`[WA] Send error:`, e.message);
    return false;
  }
}

function emitToAdmin(event, data) {
  if (_io) _io.emit(event, data);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  setIO, initAllSessions, startSession, stopSession,
  restartSession, getSessionStatus, getSessionQR,
  getAllSessionStatuses, sendMessage
};
