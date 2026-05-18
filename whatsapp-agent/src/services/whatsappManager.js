const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const db = require('../db/database');
const { handleMessage } = require('../agent/appointmentAgent');

const sessions = {};

let _io = null;

function setIO(io) {
  _io = io;
}

async function initAllSessions() {
  const clients = db.getAllClients().filter(
    (c) => c.status === 'active'
  );

  console.log(
    `[WA] Restoring ${clients.length} active sessions...`
  );

  for (const client of clients) {
    try {
      await startSession(client.id);
      await sleep(2000);
    } catch (err) {
      console.error(
        `[WA] Failed restoring ${client.id}:`,
        err.message
      );
    }
  }
}

async function startSession(clientId) {
  try {
    if (
      sessions[clientId] &&
      sessions[clientId].status === 'ready'
    ) {
      return;
    }

    const client = db.getClient(clientId);

    if (!client) return;

    console.log(
      `[WA] Starting session for: ${client.businessName} (${clientId})`
    );

    const sessionsPath = path.join(
      __dirname,
      '../../data/sessions'
    );

    const sessionDir = path.join(
      sessionsPath,
      clientId
    );

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, {
        recursive: true
      });
    }

    console.log(
      `[WA] Chrome executable: ${puppeteer.executablePath()}`
    );

    const waClient = new Client({
      authStrategy: new LocalAuth({
        clientId,
        dataPath: sessionsPath
      }),

      puppeteer: {
        executablePath: puppeteer.executablePath(),

        headless: true,

        timeout: 120000,

        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920x1080',
          '--disable-features=site-per-process',
          '--no-zygote'
        ]
      },

      webVersionCache: {
        type: 'remote',
        remotePath:
          'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
      }
    });

    sessions[clientId] = {
      client: waClient,
      qr: null,
      qrBase64: null,
      status: 'initializing'
    };

    waClient.on('qr', async (qr) => {
      console.log(`[WA] QR generated for ${clientId}`);

      sessions[clientId].qr = qr;
      sessions[clientId].status = 'qr_pending';

      try {
        sessions[clientId].qrBase64 =
          await qrcode.toDataURL(qr);
      } catch (err) {
        console.error(
          '[WA] QR generation error:',
          err.message
        );
      }

      emitToAdmin('qr_update', {
        clientId,
        qrBase64: sessions[clientId].qrBase64,
        status: 'qr_pending'
      });
    });

    waClient.on('authenticated', () => {
      console.log(
        `[WA] Authenticated: ${client.businessName}`
      );

      sessions[clientId].status = 'authenticated';

      emitToAdmin('status_update', {
        clientId,
        status: 'authenticated'
      });
    });

    waClient.on('ready', () => {
      console.log(
        `[WA] ✅ Ready: ${client.businessName}`
      );

      sessions[clientId].status = 'ready';
      sessions[clientId].qr = null;
      sessions[clientId].qrBase64 = null;

      db.updateClient(clientId, {
        sessionConnected: true,
        lastSeen: new Date().toISOString()
      });

      emitToAdmin('status_update', {
        clientId,
        status: 'ready'
      });
    });

    waClient.on('auth_failure', (msg) => {
      console.error(
        `[WA] Auth failure (${clientId}):`,
        msg
      );

      sessions[clientId].status = 'auth_failed';

      db.updateClient(clientId, {
        sessionConnected: false
      });

      emitToAdmin('status_update', {
        clientId,
        status: 'auth_failed'
      });
    });

    waClient.on('disconnected', async (reason) => {
      console.log(
        `[WA] Disconnected (${clientId}):`,
        reason
      );

      sessions[clientId].status = 'disconnected';

      db.updateClient(clientId, {
        sessionConnected: false
      });

      emitToAdmin('status_update', {
        clientId,
        status: 'disconnected'
      });

      setTimeout(async () => {
        try {
          if (db.isClientActive(clientId)) {
            console.log(
              `[WA] Restarting session: ${clientId}`
            );

            await startSession(clientId);
          }
        } catch (err) {
          console.error(
            '[WA] Restart error:',
            err.message
          );
        }
      }, 30000);
    });

    waClient.on('message', async (msg) => {
      try {
        if (
          msg.fromMe ||
          msg.from.includes('@g.us') ||
          msg.type !== 'chat'
        ) {
          return;
        }

        const messageText = msg.body?.trim();

        if (!messageText) return;

        if (!db.isClientActive(clientId)) {
          await msg.reply(
            '⚠️ Service temporarily unavailable.'
          );

          return;
        }

        const contact = await msg.getContact();

        const userName =
          contact.pushname ||
          contact.name ||
          'Customer';

        console.log(
          `[MSG] ${userName}: ${messageText}`
        );

        const response = await handleMessage(
          clientId,
          msg.from,
          userName,
          messageText
        );

        if (response) {
          await msg.reply(response);
        }

        emitToAdmin('new_message', {
          clientId,
          from: msg.from,
          name: userName,
          message: messageText,
          response: response || '(no reply)',
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error(
          '[WA] Message handler error:',
          err.message
        );
      }
    });

    console.log(
      `[WA] Initializing WhatsApp client for ${clientId}`
    );

    await waClient.initialize();

  } catch (err) {
    console.error(
      '[WA] Session start error:',
      err.message
    );

    sessions[clientId] = {
      status: 'error',
      qr: null,
      qrBase64: null
    };
  }
}

async function stopSession(clientId) {
  try {
    if (sessions[clientId]?.client) {
      await sessions[clientId].client.destroy();
    }
  } catch (err) {
    console.error(
      '[WA] Stop session error:',
      err.message
    );
  }

  sessions[clientId] = {
    status: 'stopped',
    qr: null,
    qrBase64: null
  };

  db.updateClient(clientId, {
    sessionConnected: false
  });
}

async function restartSession(clientId) {
  await stopSession(clientId);

  await sleep(3000);

  await startSession(clientId);
}

function getSessionStatus(clientId) {
  return sessions[clientId]
    ? sessions[clientId].status
    : 'not_started';
}

function getSessionQR(clientId) {
  return sessions[clientId]
    ? sessions[clientId].qrBase64
    : null;
}

function getAllSessionStatuses() {
  const result = {};

  for (const [id, s] of Object.entries(sessions)) {
    result[id] = {
      status: s.status,
      hasQR: !!s.qrBase64
    };
  }

  return result;
}

async function sendMessage(
  clientId,
  toPhone,
  message
) {
  try {
    const s = sessions[clientId];

    if (!s || s.status !== 'ready') {
      return false;
    }

    const formattedNumber = toPhone.includes('@c.us')
      ? toPhone
      : `${toPhone}@c.us`;

    await s.client.sendMessage(
      formattedNumber,
      message
    );

    return true;

  } catch (err) {
    console.error(
      '[WA] Send message error:',
      err.message
    );

    return false;
  }
}

function emitToAdmin(event, data) {
  if (_io) {
    _io.emit(event, data);
  }
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

module.exports = {
  setIO,
  initAllSessions,
  startSession,
  stopSession,
  restartSession,
  getSessionStatus,
  getSessionQR,
  getAllSessionStatuses,
  sendMessage
};
