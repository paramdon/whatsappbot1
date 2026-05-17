// src/services/whatsappManager.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { handleMessage } = require('../agent/appointmentAgent');

const sessions = {};
let _io = null;

function setIO(io) { _io = io; }

async function initAllSessions() {
  const clients = db.getAllClients().filter(c => c.status === 'active');
  console.log(`[WA] Restoring ${clients.length} active sessions...`);
  for (const client of clients) {
    await startSession(client.id);
    await sleep(2000);
  }
}

function getChromePath() {
  const paths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/app/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome',
    '/app/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome',
    '/root/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      console.log(`[WA] Chrome found at: ${p}`);
      return p;
    }
  }
  console.log('[WA] No Chrome path found, letting puppeteer auto-detect...');
  return undefined;
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

  const chromePath = getChromePath();

  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate'
    ]
  };

  if (chromePath) {
    puppeteerConfig.executablePath = chromePath;
  }

  const waClient = new Client({
    authStrategy: new LocalAuth({ clientId, dataPath: path.join(__dirname, '../../data/sessions') }),
    puppeteer: puppeteerConfig,
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' }
  });

  sessions[clientId] = { client: waClient, qr: null, status: 'initializing', qrBase64: null };

  waClient.on('qr', async (qr) => {
    console.log(`[WA] QR received for ${clientId}`);
    sessions[clientId].qr = qr;
    sessions[clientId].status = 'qr_pending';
    try {
      sessions[clientId].qrBase64 = await qrcode.toDataURL(qr);
    } catch (e) {}
    emitToAdmin('qr_update', { clientId, qrBase64: sessions[clientId].qrBase64, status: 'qr_pending' });
  });

  waClient.on('ready', () => {
    console.log(`[WA] ✅ Ready: ${client.businessName}`);
    sessions[clientId].status = 'ready';
    sessions[clientId].qr = null;
    sessions[clientId].qrBase64 = null;
    db.updateClient(clientId, { sessionConnected: true, lastSeen: new Date().toISOString() });
    emitToAdmin('status_update', { clientId, status: 'ready' });
  });

  waClient.on('authenticated', () => {
    sessions[clientId].status = 'authenticated';
    emitToAdmin('status_update', { clientId, status: 'authenticated' });
  });

  waClient.on('auth_failure', () => {
    console.log(`[WA] Auth failure for ${clientId}`);
    sessions[clientId].status = 'auth_failed';
    db.updateClient(clientId, { sessionConnected: false });
    emitToAdmin('status_update', { clientId, status: 'auth_failed' });
  });

  waClient.on('disconnected', async (reason) => {
    console.log(`[WA] Disconnected: ${clientId} — ${reason}`);
    sessions[clientId].status = 'disconnected';
    db.updateClient(clientId, { sessionConnected: false });
    emitToAdmin('status_update', { clientId, status: 'disconnected' });
    setTimeout(() => {
      if (db.isClientActive(clientId)) {
        console.log(`[WA] Auto-reconnecting: ${clientId}`);
        startSession(clientId);
      }
    }, 30000);
  });

  waClient.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;
      if (msg.from.includes('@g.us')) return;
      if (msg.type !== 'chat') return;
      const userPhone = msg.from;
      const messageText = msg.body.trim();
      if (!messageText) return;
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
      emitToAdmin('new_message', {
        clientId, from: userPhone, name: userName,
        message: messageText, response: response || '(no reply)',
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
    try { await sessions[clientId].client.destroy(); } catch (e) {}
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
