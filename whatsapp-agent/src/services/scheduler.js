// src/services/scheduler.js
// Runs background jobs: appointment reminders, expiry checks, keep-alive

const cron = require('node-cron');
const moment = require('moment-timezone');
const db = require('../db/database');
const wa = require('./whatsappManager');
const axios = require('axios');

function startScheduler() {
  // ── Appointment reminders — every 30 minutes ──────────────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      await sendReminders();
    } catch (e) {
      console.error('[CRON] Reminder error:', e.message);
    }
  });

  // ── Expiry check — daily at 9am ───────────────────────────────
  cron.schedule('0 9 * * *', async () => {
    try {
      await checkExpiryAndNotify();
    } catch (e) {
      console.error('[CRON] Expiry check error:', e.message);
    }
  });

  // ── Auto-suspend expired clients — every hour ─────────────────
  cron.schedule('0 * * * *', () => {
    const clients = db.getAllClients();
    for (const c of clients) {
      if (c.status === 'active' && moment().isAfter(moment(c.expiryDate))) {
        db.updateClient(c.id, { status: 'expired' });
        console.log(`[CRON] Suspended expired client: ${c.businessName}`);
      }
    }
  });

  // ── Render keep-alive ping — every 14 minutes (prevents sleep) ─
  if (process.env.KEEP_ALIVE_URL) {
    cron.schedule('*/14 * * * *', async () => {
      try {
        await axios.get(process.env.KEEP_ALIVE_URL, { timeout: 5000 });
        console.log('[PING] Keep-alive sent');
      } catch (e) {
        // silent
      }
    });
  }

  console.log('[CRON] Scheduler started.');
}

async function sendReminders() {
  const clients = db.getAllClients().filter(c => c.status === 'active' && c.config.reminderEnabled);

  for (const client of clients) {
    const reminderHours = client.config.reminderHours || 2;
    const now = moment().tz(client.config.timezone || 'Asia/Kolkata');
    const reminderTime = now.clone().add(reminderHours, 'hours');
    const targetDate = reminderTime.format('YYYY-MM-DD');
    const targetTime = reminderTime.format('HH:mm');

    const appts = db.getAllAppointments(client.id, { date: targetDate, status: 'confirmed' })
      .filter(a => a.time === targetTime && !a.reminderSent);

    for (const appt of appts) {
      const phone = `${appt.userPhone}@c.us`;
      const lang = 'english'; // could store per-user preference

      const msg = lang === 'hinglish'
        ? `⏰ *Reminder!* Aapka *${appt.serviceName}* appointment hai *${appt.date}* ko *${appt.time}* baje.\n\nCancel karna ho toh "cancel" type karein. 😊`
        : `⏰ *Reminder!* You have a *${appt.serviceName}* appointment on *${appt.date}* at *${appt.time}*.\n\nType "cancel" if you need to cancel. 😊`;

      const sent = await wa.sendMessage(client.id, phone, msg);
      if (sent) {
        db.updateAppointment(client.id, appt.id, { reminderSent: true });
        console.log(`[REMINDER] Sent to ${appt.userPhone} for ${appt.serviceName}`);
      }
    }
  }
}

async function checkExpiryAndNotify() {
  // Warn clients expiring in 3 days
  const expiring = db.getExpiringClients(3);
  for (const c of expiring) {
    const daysLeft = moment(c.expiryDate).diff(moment(), 'days');
    console.log(`[EXPIRY] Warning: ${c.businessName} expires in ${daysLeft} days`);
    // You can add owner notification via WhatsApp here if needed
    // wa.sendMessage(c.id, c.whatsappNumber, `...`)
  }
}

module.exports = { startScheduler };
