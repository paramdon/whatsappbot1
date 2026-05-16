// src/routes/dashboard.js
// Each client (business owner) uses this to manage their bot

const express = require('express');
const router = express.Router();
const moment = require('moment');
const db = require('../db/database');
const wa = require('../services/whatsappManager');
const bcrypt = require('bcryptjs');
const { requireClient } = require('../middleware/auth');

// ── Client Login ──────────────────────────────────────────────────
router.get('/login', (req, res) => {
  const expired = req.query.expired === '1';
  res.send(clientLoginPage(expired));
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { apiKey } = req.body;
  const clients = db.getAllClients();
  const client = clients.find(c => c.apiKey === apiKey && c.status === 'active');

  if (!client) {
    return res.redirect('/dashboard/login?error=1');
  }

  if (!db.isClientActive(client.id)) {
    return res.redirect('/dashboard/login?expired=1');
  }

  req.session.clientId = client.id;
  res.redirect('/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/dashboard/login');
});

// ── Main Dashboard ────────────────────────────────────────────────
router.get('/', requireClient, (req, res) => {
  const client = req.client;
  const appts = db.getAllAppointments(client.id, { limit: 20 });
  const todayAppts = db.getAllAppointments(client.id, {
    date: moment().format('YYYY-MM-DD'),
    status: 'confirmed'
  });
  const waStatus = wa.getSessionStatus(client.id);
  const daysLeft = moment(client.expiryDate).diff(moment(), 'days');

  res.send(clientDashboardPage(client, appts, todayAppts, waStatus, daysLeft));
});

// ── API: Get QR ───────────────────────────────────────────────────
router.get('/api/qr', requireClient, (req, res) => {
  const qr = wa.getSessionQR(req.client.id);
  const status = wa.getSessionStatus(req.client.id);
  res.json({ qr, status });
});

// ── API: Restart session ──────────────────────────────────────────
router.post('/api/restart', requireClient, async (req, res) => {
  await wa.restartSession(req.client.id);
  res.json({ success: true });
});

// ── API: Get config ───────────────────────────────────────────────
router.get('/api/config', requireClient, (req, res) => {
  res.json(req.client.config);
});

// ── API: Update config ────────────────────────────────────────────
router.post('/api/config', requireClient, express.json(), (req, res) => {
  try {
    const allowed = [
      'welcomeMessage', 'offHoursMessage', 'workingHours', 'services',
      'slotDuration', 'breakTime', 'autoConfirm', 'reminderEnabled',
      'reminderHours', 'ownerNotify', 'collectName', 'collectNotes',
      'faqs', 'botName', 'language', 'maxDailySlots'
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const newConfig = db.updateClientConfig(req.client.id, updates);
    res.json({ success: true, config: newConfig });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── API: Get appointments ─────────────────────────────────────────
router.get('/api/appointments', requireClient, (req, res) => {
  const { date, status } = req.query;
  const appts = db.getAllAppointments(req.client.id, { date, status, limit: 50 });
  res.json(appts);
});

// ── API: Update appointment ───────────────────────────────────────
router.post('/api/appointments/:id', requireClient, express.json(), (req, res) => {
  db.updateAppointment(req.client.id, req.params.id, req.body);
  res.json({ success: true });
});

// ── API: Available slots ──────────────────────────────────────────
router.get('/api/slots', requireClient, (req, res) => {
  const { date } = req.query;
  if (!date) return res.json([]);
  const slots = db.getAvailableSlots(req.client.id, date);
  res.json(slots);
});

// ────────────────────────────────────────────────────────────────────
// CLIENT DASHBOARD HTML
// ────────────────────────────────────────────────────────────────────

function clientLoginPage(expired) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Business Dashboard Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1e293b;border-radius:16px;padding:40px;width:100%;max-width:400px}
h1{color:#fff;text-align:center;margin-bottom:8px}
p{color:#94a3b8;text-align:center;margin-bottom:28px;font-size:14px}
label{display:block;color:#cbd5e1;font-size:13px;margin-bottom:6px}
input{width:100%;padding:12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:15px;margin-bottom:20px}
button{width:100%;padding:13px;background:#10b981;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;font-weight:600}
.alert{background:#7f1d1d;color:#fca5a5;padding:12px;border-radius:8px;margin-bottom:16px;font-size:13px;text-align:center}
.alert-warn{background:#451a03;color:#fde68a}
</style>
</head>
<body>
<div class="card">
  <h1>🤖 Bot Dashboard</h1>
  <p>Enter your access key to manage your WhatsApp bot</p>
  ${expired ? '<div class="alert alert-warn">⚠️ Your subscription has expired. Please contact support to renew.</div>' : ''}
  <form method="POST">
    <label>Access Key</label>
    <input type="password" name="apiKey" placeholder="••••••••••••••••" required>
    <button type="submit">Login →</button>
  </form>
</div>
</body></html>`;
}

function clientDashboardPage(client, appts, todayAppts, waStatus, daysLeft) {
  const cfg = client.config;
  const isConnected = waStatus === 'ready';
  const totalAppts = appts.length;
  const confirmed = appts.filter(a => a.status === 'confirmed').length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${client.businessName} — Bot Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f1f5f9;min-height:100vh}
.topbar{background:#fff;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e2e8f0;position:sticky;top:0;z-index:10}
.topbar .logo{font-weight:700;font-size:16px;color:#0f172a}
.topbar .meta{font-size:13px;color:#64748b}
nav{background:#0f172a;padding:0 24px;display:flex;gap:0}
nav button{background:none;border:none;color:#94a3b8;padding:14px 18px;cursor:pointer;font-size:14px;border-bottom:3px solid transparent}
nav button.active{color:#10b981;border-bottom-color:#10b981}
.container{padding:24px;max-width:1100px;margin:0 auto}
.page{display:none}.page.active{display:block}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;margin-bottom:24px}
.stat{background:#fff;border-radius:12px;padding:20px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.stat .num{font-size:26px;font-weight:700;color:#6366f1}
.stat .label{font-size:12px;color:#64748b;margin-top:4px}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.06);margin-bottom:20px}
.card h3{font-size:15px;font-weight:600;color:#0f172a;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #f1f5f9}
.badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600}
.green{background:#dcfce7;color:#166534}
.red{background:#fee2e2;color:#991b1b}
.yellow{background:#fef9c3;color:#92400e}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;padding:8px 12px;background:#f8fafc;border-radius:4px}
td{padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:13px}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:12px;color:#64748b;margin-bottom:6px;font-weight:500}
.form-group input,.form-group select,.form-group textarea{width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;color:#0f172a}
.form-group textarea{min-height:80px;resize:vertical}
.btn{padding:10px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600}
.btn-green{background:#10b981;color:#fff}
.btn-blue{background:#6366f1;color:#fff}
.btn-red{background:#ef4444;color:#fff}
.btn-sm{padding:5px 10px;font-size:11px}
.wa-status{display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:10px}
.wa-status.connected{background:#dcfce7;color:#166534}
.wa-status.disconnected{background:#fee2e2;color:#991b1b}
.section-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:600px){.section-grid{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}}
.service-item{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:8px}
.service-item input{flex:1;padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px}
.chip{background:#e0e7ff;color:#4338ca;padding:4px 10px;border-radius:20px;font-size:11px;display:inline-block;margin:2px}
.day-btn{padding:8px 14px;border:2px solid #e2e8f0;border-radius:8px;cursor:pointer;font-size:13px;background:#fff;margin:3px}
.day-btn.active{border-color:#10b981;background:#dcfce7;color:#166534}
#qrBox img{max-width:220px;margin:0 auto;display:block}
.appt-today{background:#eff6ff;border-left:4px solid #3b82f6;padding:10px 14px;border-radius:6px;margin-bottom:8px}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">🤖 ${client.businessName}</div>
  <div style="display:flex;gap:16px;align-items:center">
    <div class="meta">Expires: ${new Date(client.expiryDate).toLocaleDateString()} 
      ${daysLeft < 7 ? `<span style="color:#ef4444">(${daysLeft}d left!)</span>` : `(${daysLeft}d)`}
    </div>
    <a href="/dashboard/logout" style="color:#64748b;font-size:13px;text-decoration:none">Logout</a>
  </div>
</div>
<nav>
  <button class="active" onclick="showPage('home',this)">🏠 Home</button>
  <button onclick="showPage('appointments',this)">📅 Appointments</button>
  <button onclick="showPage('settings',this)">⚙️ Settings</button>
  <button onclick="showPage('connect',this)">📱 WhatsApp</button>
</nav>
<div class="container">

  <!-- HOME PAGE -->
  <div class="page active" id="page-home">
    <div class="stats">
      <div class="stat"><div class="num">${totalAppts}</div><div class="label">Total Bookings</div></div>
      <div class="stat"><div class="num" style="color:#10b981">${confirmed}</div><div class="label">Confirmed</div></div>
      <div class="stat"><div class="num" style="color:#3b82f6">${todayAppts.length}</div><div class="label">Today</div></div>
      <div class="stat"><div class="num" style="color:${daysLeft < 7 ? '#ef4444' : '#6366f1'}">${daysLeft}</div><div class="label">Days Left</div></div>
    </div>

    <div class="wa-status ${isConnected ? 'connected' : 'disconnected'}">
      ${isConnected
        ? '✅ <strong>WhatsApp Connected</strong> — Bot is live and receiving messages'
        : '❌ <strong>WhatsApp Disconnected</strong> — Go to the WhatsApp tab to reconnect'}
    </div>

    ${todayAppts.length > 0 ? `
    <div class="card" style="margin-top:20px">
      <h3>📅 Today's Appointments (${todayAppts.length})</h3>
      ${todayAppts.map(a => `
        <div class="appt-today">
          <strong>${a.time}</strong> — ${a.serviceName} | ${a.userName}
          ${a.notes ? `<br><span style="font-size:12px;color:#64748b">Note: ${a.notes}</span>` : ''}
        </div>
      `).join('')}
    </div>` : ''}

    <div class="card" style="margin-top:20px">
      <h3>🔗 Share Your Bot</h3>
      <p style="font-size:13px;color:#64748b;margin-bottom:12px">Send this message to your customers to start using the bot:</p>
      <div style="background:#f8fafc;padding:14px;border-radius:8px;font-size:13px;color:#334155">
        Hi! Book appointments easily with our WhatsApp bot.<br>
        Just send a message to: <strong>wa.me/${client.whatsappNumber}</strong>
      </div>
    </div>
  </div>

  <!-- APPOINTMENTS PAGE -->
  <div class="page" id="page-appointments">
    <div class="card">
      <h3>📅 All Appointments</h3>
      <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
        <input type="date" id="filterDate" style="padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px" onchange="filterAppts()">
        <select id="filterStatus" style="padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px" onchange="filterAppts()">
          <option value="">All Status</option>
          <option value="confirmed">Confirmed</option>
          <option value="cancelled">Cancelled</option>
          <option value="completed">Completed</option>
        </select>
        <button class="btn btn-sm btn-blue" onclick="filterAppts()">Filter</button>
      </div>
      <table>
        <thead><tr><th>Date/Time</th><th>Service</th><th>Customer</th><th>Status</th><th>Action</th></tr></thead>
        <tbody id="apptsBody">
          ${appts.map(a => `
            <tr>
              <td>${a.date}<br><strong>${a.time}</strong></td>
              <td>${a.serviceName}<br>${a.fee > 0 ? `<span class="chip">₹${a.fee}</span>` : ''}</td>
              <td>${a.userName}<br><span style="font-size:11px;color:#64748b">${a.userPhone}</span></td>
              <td><span class="badge ${a.status === 'confirmed' ? 'green' : a.status === 'cancelled' ? 'red' : 'yellow'}">${a.status}</span></td>
              <td>
                ${a.status === 'confirmed' ? `
                  <button class="btn btn-sm" style="background:#e0e7ff;color:#4338ca" onclick="markDone('${a.id}')">✓ Done</button>
                  <button class="btn btn-sm btn-red" onclick="markCancel('${a.id}')">✕</button>
                ` : '—'}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <!-- SETTINGS PAGE -->
  <div class="page" id="page-settings">
    <div class="section-grid">
      <div>
        <div class="card">
          <h3>🤖 Bot Personality</h3>
          <div class="form-group">
            <label>Bot Name</label>
            <input type="text" id="s_botName" value="${cfg.botName || 'Assistant'}">
          </div>
          <div class="form-group">
            <label>Welcome Message</label>
            <textarea id="s_welcome">${cfg.welcomeMessage || ''}</textarea>
          </div>
          <div class="form-group">
            <label>Off-Hours Message</label>
            <textarea id="s_offhours">${cfg.offHoursMessage || ''}</textarea>
          </div>
        </div>

        <div class="card">
          <h3>⏰ Working Hours</h3>
          <div class="form-group">
            <label>Start Time</label>
            <input type="time" id="s_whStart" value="${cfg.workingHours?.start || '09:00'}">
          </div>
          <div class="form-group">
            <label>End Time</label>
            <input type="time" id="s_whEnd" value="${cfg.workingHours?.end || '18:00'}">
          </div>
          <div class="form-group">
            <label>Open Days</label>
            <div id="daysSelector">
              ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) =>
                `<button type="button" class="day-btn ${(cfg.workingHours?.days || [1,2,3,4,5,6]).includes(i) ? 'active' : ''}"
                  data-day="${i}" onclick="toggleDay(this)">${d}</button>`
              ).join('')}
            </div>
          </div>
          <div class="form-group">
            <label>Slot Duration (minutes)</label>
            <select id="s_slot">
              ${[15,20,30,45,60,90].map(v => `<option ${cfg.slotDuration === v ? 'selected' : ''} value="${v}">${v} min</option>`).join('')}
            </select>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <h3>🗂️ Services</h3>
          <div id="servicesList">
            ${(cfg.services || []).map((s, i) => `
              <div class="service-item" data-idx="${i}">
                <div style="flex:1">
                  <input class="svc-name" placeholder="Service name" value="${s.name}" style="margin-bottom:4px">
                  <div style="display:flex;gap:6px">
                    <input class="svc-dur" placeholder="Min" type="number" value="${s.duration}" style="width:70px">
                    <input class="svc-fee" placeholder="₹Fee" type="number" value="${s.fee}" style="width:80px">
                  </div>
                </div>
                <button class="btn btn-sm btn-red" onclick="removeService(${i})">✕</button>
              </div>
            `).join('')}
          </div>
          <button class="btn btn-sm btn-blue" style="margin-top:8px" onclick="addService()">+ Add Service</button>
        </div>

        <div class="card">
          <h3>🔔 Options</h3>
          <div style="display:flex;flex-direction:column;gap:12px">
            ${[
              ['s_remind', cfg.reminderEnabled, 'Send appointment reminders'],
              ['s_collectName', cfg.collectName, 'Collect customer name'],
              ['s_collectNotes', cfg.collectNotes, 'Collect notes/symptoms'],
              ['s_autoConfirm', cfg.autoConfirm, 'Auto-confirm bookings'],
            ].map(([id, val, label]) => `
              <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer">
                <input type="checkbox" id="${id}" ${val ? 'checked' : ''} style="width:16px;height:16px">
                ${label}
              </label>
            `).join('')}
          </div>
        </div>
      </div>
    </div>

    <div style="text-align:right;margin-top:8px">
      <button class="btn btn-green" onclick="saveSettings()">💾 Save All Settings</button>
    </div>
  </div>

  <!-- WHATSAPP PAGE -->
  <div class="page" id="page-connect">
    <div class="card" style="max-width:480px;margin:0 auto">
      <h3>📱 WhatsApp Connection</h3>
      <div class="wa-status ${isConnected ? 'connected' : 'disconnected'}" style="margin-bottom:20px">
        Status: <strong>${waStatus}</strong>
      </div>
      <div id="qrBox" style="text-align:center;padding:20px">
        ${isConnected
          ? '<p style="color:#166534;font-size:16px">✅ Your bot is connected and running!</p>'
          : '<p style="color:#64748b">Loading QR code...</p>'}
      </div>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="btn btn-blue" onclick="loadQR()">🔄 Refresh QR</button>
        <button class="btn" style="background:#f1f5f9;color:#334155" onclick="restartBot()">↺ Restart Bot</button>
      </div>
      <div style="margin-top:20px;background:#f8fafc;border-radius:8px;padding:16px;font-size:13px;color:#475569">
        <strong>How to connect:</strong><br>
        1. Open WhatsApp on your phone<br>
        2. Tap ⋮ → Linked Devices → Link a Device<br>
        3. Scan the QR code above<br>
        4. Status will change to "ready" ✅
      </div>
    </div>
  </div>

</div>

<script>
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'connect') loadQR();
}

function toggleDay(btn) {
  btn.classList.toggle('active');
}

function addService() {
  const list = document.getElementById('servicesList');
  const idx = list.children.length;
  const div = document.createElement('div');
  div.className = 'service-item';
  div.dataset.idx = idx;
  div.innerHTML = \`
    <div style="flex:1">
      <input class="svc-name" placeholder="Service name" value="" style="margin-bottom:4px">
      <div style="display:flex;gap:6px">
        <input class="svc-dur" placeholder="Min" type="number" value="30" style="width:70px">
        <input class="svc-fee" placeholder="₹Fee" type="number" value="0" style="width:80px">
      </div>
    </div>
    <button class="btn btn-sm btn-red" onclick="removeService(\${idx})">✕</button>
  \`;
  list.appendChild(div);
}

function removeService(idx) {
  const item = document.querySelector(\`[data-idx="\${idx}"]\`);
  if (item) item.remove();
}

function getServices() {
  return Array.from(document.querySelectorAll('.service-item')).map((el, i) => ({
    id: 's' + (i+1),
    name: el.querySelector('.svc-name').value,
    duration: parseInt(el.querySelector('.svc-dur').value) || 30,
    fee: parseInt(el.querySelector('.svc-fee').value) || 0
  })).filter(s => s.name.trim());
}

async function saveSettings() {
  const days = Array.from(document.querySelectorAll('.day-btn.active')).map(b => parseInt(b.dataset.day));
  const config = {
    botName: document.getElementById('s_botName').value,
    welcomeMessage: document.getElementById('s_welcome').value,
    offHoursMessage: document.getElementById('s_offhours').value,
    workingHours: {
      start: document.getElementById('s_whStart').value,
      end: document.getElementById('s_whEnd').value,
      days
    },
    slotDuration: parseInt(document.getElementById('s_slot').value),
    services: getServices(),
    reminderEnabled: document.getElementById('s_remind').checked,
    collectName: document.getElementById('s_collectName').checked,
    collectNotes: document.getElementById('s_collectNotes').checked,
    autoConfirm: document.getElementById('s_autoConfirm').checked
  };
  const r = await fetch('/dashboard/api/config', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(config)
  });
  const d = await r.json();
  if (d.success) alert('✅ Settings saved!');
  else alert('Error: ' + d.error);
}

async function filterAppts() {
  const date = document.getElementById('filterDate').value;
  const status = document.getElementById('filterStatus').value;
  let url = '/dashboard/api/appointments?';
  if (date) url += 'date=' + date + '&';
  if (status) url += 'status=' + status;
  const r = await fetch(url);
  const appts = await r.json();
  document.getElementById('apptsBody').innerHTML = appts.map(a => \`
    <tr>
      <td>\${a.date}<br><strong>\${a.time}</strong></td>
      <td>\${a.serviceName}\${a.fee > 0 ? '<br><span class="chip">₹'+a.fee+'</span>' : ''}</td>
      <td>\${a.userName}<br><span style="font-size:11px;color:#64748b">\${a.userPhone}</span></td>
      <td><span class="badge \${a.status === 'confirmed' ? 'green' : a.status === 'cancelled' ? 'red' : 'yellow'}">\${a.status}</span></td>
      <td>\${a.status === 'confirmed' ? '<button class="btn btn-sm" style="background:#e0e7ff;color:#4338ca" onclick="markDone(\''+a.id+'\')">✓</button>' : '—'}</td>
    </tr>
  \`).join('');
}

async function markDone(id) {
  await fetch('/dashboard/api/appointments/' + id, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({status:'completed'}) });
  filterAppts();
}

async function markCancel(id) {
  await fetch('/dashboard/api/appointments/' + id, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({status:'cancelled'}) });
  filterAppts();
}

let qrInterval = null;
async function loadQR() {
  if (qrInterval) clearInterval(qrInterval);
  document.getElementById('qrBox').innerHTML = '<p style="color:#64748b">Loading...</p>';
  qrInterval = setInterval(async () => {
    const r = await fetch('/dashboard/api/qr');
    const d = await r.json();
    if (d.status === 'ready') {
      clearInterval(qrInterval);
      document.getElementById('qrBox').innerHTML = '<p style="color:#166534;font-size:16px">✅ Connected!</p>';
    } else if (d.qr) {
      document.getElementById('qrBox').innerHTML = '<img src="' + d.qr + '" style="max-width:220px">';
    } else {
      document.getElementById('qrBox').innerHTML = '<p style="color:#64748b">Waiting for QR... (' + d.status + ')</p>';
    }
  }, 3000);
}

async function restartBot() {
  if (!confirm('Restart the bot? It will disconnect briefly.')) return;
  await fetch('/dashboard/api/restart', { method:'POST' });
  alert('Restarting... refresh QR in 30 seconds.');
}
</script>
</body></html>`;
}

module.exports = router;
