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

async function startSession(clientId) {
  if (sessions[clientId] && sessions[clientId].status === 'ready') return;
  const client = db.getClient(clientId);
  if (!client) return;
  console.log(`[WA] Starting: ${client.businessName}`);
  const sessionDir = path.join(__dirname, '../../data/sessions', clientId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const waClient = new Client({
    authStrategy: new LocalAuth({ clientId, dataPath: path.join(__dirname, '../../data/sessions') }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--no-zygote','--single-process','--disable-gpu']
    },
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' }
  });

  sessions[clientId] = { client: waClient, qr: null, status: 'initializing', qrBase64: null };

  waClient.on('qr', async (qr) => {
    sessions[clientId].qr = qr;
    sessions[clientId].status = 'qr_pending';
    try { sessions[clientId].qrBase64 = await qrcode.toDataURL(qr); } catch (e) {}
    emitToAdmin('qr_update', { clientId, qrBase64: sessions[clientId].qrBase64, status: 'qr_pending' });
    console.log(`[WA] QR ready for ${clientId}`);
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
    sessions[clientId].status = 'auth_failed';
    db.updateClient(clientId, { sessionConnected: false });
    emitToAdmin('status_update', { clientId, status: 'auth_failed' });
  });

  waClient.on('disconnected', async (reason) => {
    console.log(`[WA] Disconnected: ${clientId}`);
    sessions[clientId].status = 'disconnected';
    db.updateClient(clientId, { sessionConnected: false });
    emitToAdmin('status_update', { clientId, status: 'disconnected' });
    setTimeout(() => { if (db.isClientActive(clientId)) startSession(clientId); }, 30000);
  });

  waClient.on('message', async (msg) => {
    try {
      if (msg.fromMe || msg.from.includes('@g.us') || msg.type !== 'chat') return;
      const messageText = msg.body.trim();
      if (!messageText) return;
      if (!db.isClientActive(clientId)) { await msg.reply('⚠️ Service unavailable.'); return; }
      const contact = await msg.getContact();
      const userName = contact.pushname || contact.name || 'Customer';
      const response = await handleMessage(clientId, msg.from, userName, messageText);
      if (response) await msg.reply(response);
      emitToAdmin('new_message', { clientId, from: msg.from, name: userName, message: messageText, response: response || '(no reply)', timestamp: new Date().toISOString() });
    } catch (err) { console.error(`[WA] Error:`, err.message); }
  });

  await waClient.initialize();
}

async function stopSession(clientId) {
  if (sessions[clientId]?.client) { try { await sessions[clientId].client.destroy(); } catch (e) {} }
  sessions[clientId] = { status: 'stopped', qr: null, qrBase64: null };
  db.updateClient(clientId, { sessionConnected: false });
}

async function restartSession(clientId) { await stopSession(clientId); await sleep(3000); await startSession(clientId); }
function getSessionStatus(clientId) { return sessions[clientId] ? sessions[clientId].status : 'not_started'; }
function getSessionQR(clientId) { return sessions[clientId] ? sessions[clientId].qrBase64 : null; }
function getAllSessionStatuses() {
  const result = {};
  for (const [id, s] of Object.entries(sessions)) result[id] = { status: s.status, hasQR: !!s.qrBase64 };
  return result;
}
async function sendMessage(clientId, toPhone, message) {
  const s = sessions[clientId];
  if (!s || s.status !== 'ready') return false;
  try { await s.client.sendMessage(toPhone.includes('@c.us') ? toPhone : `${toPhone}@c.us`, message); return true; }
  catch (e) { return false; }
}
function emitToAdmin(event, data) { if (_io) _io.emit(event, data); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { setIO, initAllSessions, startSession, stopSession, restartSession, getSessionStatus, getSessionQR, getAllSessionStatuses, sendMessage };
