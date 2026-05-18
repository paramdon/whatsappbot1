// src/routes/admin.js
// YOU (the seller) use these routes to manage all clients

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const moment = require('moment');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const wa = require('../services/whatsappManager');
const { requireAdmin } = require('../middleware/auth');

// ── Admin Login ───────────────────────────────────────────────────
router.get('/login', (req, res) => {
  const error = req.query.error === '1';
  res.send(adminLoginPage(error));
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  if (db.verifyAdmin(username, password)) {
    req.session.isAdmin = true;
    res.redirect('/admin/dashboard');
  } else {
    res.redirect('/admin/login?error=1');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// ── Admin Dashboard ───────────────────────────────────────────────
router.get('/dashboard', requireAdmin, (req, res) => {
  const clients = db.getAllClients();
  const statuses = wa.getAllSessionStatuses();
  const expiring = db.getExpiringClients(5);
  res.send(adminDashboardPage(clients, statuses, expiring));
});

// ── Create Client ─────────────────────────────────────────────────
router.post('/clients', requireAdmin, express.json(), async (req, res) => {
  try {
    // Generate API key if not provided
    if (!req.body.apiKey) {
      req.body.apiKey = 'KEY-' + uuidv4().slice(0, 16).toUpperCase();
    }
    const client = db.createClient(req.body);
    wa.startSession(client.id).catch(e => console.error('Session start error:', e.message));
    res.json({ success: true, client });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Edit Client ───────────────────────────────────────────────────
router.post('/api/clients/:id/edit', requireAdmin, express.json(), (req, res) => {
  try {
    const { name, businessName, businessType, phone, whatsappNumber, timezone } = req.body;
    db.updateClient(req.params.id, { name, businessName, businessType, phone, whatsappNumber, timezone });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Reset Access Key ──────────────────────────────────────────────
router.post('/api/clients/:id/reset-key', requireAdmin, express.json(), (req, res) => {
  try {
    const newKey = 'KEY-' + uuidv4().slice(0, 16).toUpperCase();
    db.updateClient(req.params.id, { apiKey: newKey });
    res.json({ success: true, apiKey: newKey });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Get all clients (API) ─────────────────────────────────────────
router.get('/api/clients', requireAdmin, (req, res) => {
  const clients = db.getAllClients();
  const statuses = wa.getAllSessionStatuses();
  res.json(clients.map(c => ({
    ...c,
    waStatus: statuses[c.id]?.status || 'not_started',
    daysLeft: moment(c.expiryDate).diff(moment(), 'days'),
    isExpired: moment().isAfter(moment(c.expiryDate))
  })));
});

// ── Renew client license ──────────────────────────────────────────
router.post('/api/clients/:id/renew', requireAdmin, express.json(), (req, res) => {
  const { days, months = 1, amount, note } = req.body;
  let client;
  if (days) {
    // Trial/days-based renewal
    client = db.renewClientByDays(req.params.id, parseInt(days), amount || 0, note || 'Trial');
  } else {
    client = db.renewClient(req.params.id, parseInt(months), amount || months * 1000, note);
  }
  res.json({ success: true, client });
});

// ── Suspend / Activate client ─────────────────────────────────────
router.post('/api/clients/:id/status', requireAdmin, express.json(), async (req, res) => {
  const { status } = req.body;
  db.updateClient(req.params.id, { status });
  if (status === 'suspended') await wa.stopSession(req.params.id);
  if (status === 'active') wa.startSession(req.params.id).catch(() => {});
  res.json({ success: true });
});

// ── WhatsApp Session controls ─────────────────────────────────────
router.get('/api/sessions/:id/qr', requireAdmin, (req, res) => {
  const qr = wa.getSessionQR(req.params.id);
  const status = wa.getSessionStatus(req.params.id);
  res.json({ qr, status });
});

router.post('/api/sessions/:id/restart', requireAdmin, async (req, res) => {
  await wa.restartSession(req.params.id);
  res.json({ success: true });
});

router.post('/api/sessions/:id/stop', requireAdmin, async (req, res) => {
  await wa.stopSession(req.params.id);
  res.json({ success: true });
});

// ── Get client details + appointments ────────────────────────────
router.get('/api/clients/:id', requireAdmin, (req, res) => {
  const client = db.getClient(req.params.id);
  if (!client) return res.json({ error: 'Not found' });
  const appts = db.getAllAppointments(req.params.id, { limit: 20 });
  const qr = wa.getSessionQR(req.params.id);
  const status = wa.getSessionStatus(req.params.id);
  res.json({ client, appts, waStatus: status, qr });
});

// ── Delete client ─────────────────────────────────────────────────
router.delete('/api/clients/:id', requireAdmin, async (req, res) => {
  await wa.stopSession(req.params.id);
  db.updateClient(req.params.id, { status: 'deleted' });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════
// ADMIN HTML PAGES
// ════════════════════════════════════════════════════════════════════

function adminLoginPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1e293b;border-radius:12px;padding:40px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
h1{color:#fff;text-align:center;margin-bottom:8px;font-size:22px}
p{color:#94a3b8;text-align:center;margin-bottom:28px;font-size:14px}
label{display:block;color:#cbd5e1;font-size:13px;margin-bottom:6px}
input{width:100%;padding:10px 14px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:14px;margin-bottom:16px;outline:none}
input:focus{border-color:#6366f1}
button{width:100%;padding:12px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;font-weight:600}
button:hover{background:#4f46e5}
.error{background:#7f1d1d;color:#fca5a5;padding:10px;border-radius:8px;text-align:center;margin-bottom:16px;font-size:13px}
</style>
</head>
<body>
<div class="card">
  <h1>🤖 WA Agent Admin</h1>
  <p>Seller dashboard — manage all clients</p>
  ${error ? '<div class="error">❌ Invalid username or password</div>' : ''}
  <form method="POST" action="/admin/login">
    <label>Username</label>
    <input type="text" name="username" placeholder="admin" required autocomplete="username">
    <label>Password</label>
    <input type="password" name="password" placeholder="••••••••" required autocomplete="current-password">
    <button type="submit">Login →</button>
  </form>
</div>
</body></html>`;
}

function adminDashboardPage(clients, statuses, expiring) {
  const active = clients.filter(c => c.status === 'active').length;
  const expired = clients.filter(c => c.status === 'expired' || c.status === 'suspended').length;
  const revenue = clients.reduce((s, c) => s + (c.paidMonths || 0) * 1000, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.6.1/socket.io.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.topbar{background:#1e293b;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #334155}
.topbar h1{font-size:18px;color:#fff}
.topbar a{color:#94a3b8;text-decoration:none;font-size:14px}
.container{padding:24px;max-width:1300px;margin:0 auto}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin-bottom:24px}
.stat{background:#1e293b;border-radius:12px;padding:20px;text-align:center;border:1px solid #334155}
.stat .num{font-size:28px;font-weight:700;color:#6366f1}
.stat .label{font-size:13px;color:#94a3b8;margin-top:4px}
.section-title{font-size:16px;font-weight:600;color:#fff;margin-bottom:12px}
.clients-table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden;border:1px solid #334155}
.clients-table th{background:#334155;padding:11px 14px;text-align:left;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px}
.clients-table td{padding:11px 14px;border-bottom:1px solid #1e293b;font-size:13px;vertical-align:middle}
.clients-table tr:last-child td{border-bottom:none}
.clients-table tr:hover td{background:#334155}
.badge{padding:3px 8px;border-radius:20px;font-size:11px;font-weight:600;display:inline-block}
.badge-active{background:#166534;color:#4ade80}
.badge-expired{background:#7f1d1d;color:#f87171}
.badge-suspended{background:#374151;color:#9ca3af}
.badge-ready{background:#1e3a5f;color:#60a5fa}
.badge-qr{background:#713f12;color:#fbbf24}
.badge-disconnected{background:#374151;color:#9ca3af}
.btn{padding:5px 10px;border-radius:6px;border:none;cursor:pointer;font-size:11px;font-weight:600;transition:opacity .15s}
.btn:hover{opacity:.85}
.btn-primary{background:#6366f1;color:#fff}
.btn-success{background:#16a34a;color:#fff}
.btn-danger{background:#dc2626;color:#fff}
.btn-warning{background:#d97706;color:#fff}
.btn-gray{background:#475569;color:#fff}
.btn-teal{background:#0d9488;color:#fff}
.btn-lg{padding:10px 20px;font-size:14px;border-radius:8px}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;align-items:center;justify-content:center;padding:16px}
.modal.open{display:flex}
.modal-box{background:#1e293b;border-radius:16px;padding:28px;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;border:1px solid #334155}
.modal-box h2{color:#fff;margin-bottom:20px;font-size:17px;padding-bottom:12px;border-bottom:1px solid #334155}
.form-group{margin-bottom:14px}
.form-group label{display:block;color:#94a3b8;font-size:11px;margin-bottom:5px;text-transform:uppercase;letter-spacing:.3px;font-weight:600}
.form-group input,.form-group select,.form-group textarea{width:100%;padding:9px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#fff;font-size:13px;outline:none}
.form-group input:focus,.form-group select:focus{border-color:#6366f1}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.warn-box{background:#451a03;border:1px solid #d97706;border-radius:8px;padding:14px;margin-bottom:16px;font-size:13px;color:#fde68a}
#liveLog{background:#0f172a;border-radius:8px;padding:14px;height:180px;overflow-y:auto;font-size:12px;font-family:monospace;color:#a3e635;border:1px solid #334155}
.key-box{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-family:monospace;font-size:13px;color:#fbbf24;display:flex;align-items:center;justify-content:space-between;gap:8px;word-break:break-all}
.copy-btn{background:#334155;border:none;color:#e2e8f0;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:11px;white-space:nowrap;flex-shrink:0}
.copy-btn:hover{background:#475569}
.tab-btns{display:flex;gap:0;border-bottom:1px solid #334155;margin-bottom:20px}
.tab-btn{background:none;border:none;color:#94a3b8;padding:10px 16px;cursor:pointer;font-size:13px;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab-btn.active{color:#6366f1;border-bottom-color:#6366f1}
.tab-pane{display:none}.tab-pane.active{display:block}
.trial-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:4px}
.trial-opt{border:2px solid #334155;border-radius:8px;padding:10px;cursor:pointer;text-align:center;transition:all .15s;background:#0f172a}
.trial-opt:hover,.trial-opt.selected{border-color:#6366f1;background:#1e1b4b}
.trial-opt .days{font-size:18px;font-weight:700;color:#a5b4fc}
.trial-opt .label{font-size:11px;color:#94a3b8;margin-top:2px}
.trial-opt .price{font-size:12px;color:#4ade80;margin-top:2px}
.test-steps{counter-reset:step}
.test-step{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #334155}
.test-step:last-child{border-bottom:none}
.step-num{background:#6366f1;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;margin-top:1px}
.step-text{font-size:13px;color:#cbd5e1;line-height:1.5}
.step-text strong{color:#fff}
.step-text code{background:#0f172a;padding:2px 6px;border-radius:4px;font-size:12px;color:#fbbf24}
</style>
</head>
<body>
<div class="topbar">
  <h1>🤖 WhatsApp Agent — Admin Panel</h1>
  <div style="display:flex;gap:16px;align-items:center">
    <span style="color:#4ade80;font-size:13px">● Live</span>
    <a href="/admin/logout">Logout</a>
  </div>
</div>
<div class="container">

  ${expiring.length > 0 ? `
  <div class="warn-box">
    ⚠️ <strong>${expiring.length} client(s) expiring soon:</strong>
    ${expiring.map(c => `<strong>${c.businessName}</strong> (${moment(c.expiryDate).diff(moment(), 'days')}d left)`).join(', ')}
  </div>` : ''}

  <div class="stats">
    <div class="stat"><div class="num">${clients.length}</div><div class="label">Total Clients</div></div>
    <div class="stat"><div class="num" style="color:#4ade80">${active}</div><div class="label">Active</div></div>
    <div class="stat"><div class="num" style="color:#f87171">${expired}</div><div class="label">Inactive</div></div>
    <div class="stat"><div class="num" style="color:#fbbf24">₹${(revenue/1000).toFixed(0)}K</div><div class="label">Revenue</div></div>
  </div>

  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
    <div class="section-title">📋 All Clients</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-gray btn-lg" onclick="openTestGuide()">🧪 How to Test</button>
      <button class="btn btn-primary btn-lg" onclick="openCreateModal()">+ Add Client</button>
    </div>
  </div>

  <table class="clients-table">
    <thead>
      <tr>
        <th>Business</th>
        <th>Type</th>
        <th>Access Key</th>
        <th>Expiry</th>
        <th>WhatsApp</th>
        <th>License</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="clientsBody">
      ${clients.filter(c => c.status !== 'deleted').map(c => renderClientRow(c, statuses)).join('')}
    </tbody>
  </table>

  <div style="margin-top:28px">
    <div class="section-title">📡 Live Messages</div>
    <div id="liveLog"><span style="color:#475569">Waiting for incoming messages...</span></div>
  </div>
</div>

<!-- ═══════════════════════════════════════════ -->
<!-- CREATE CLIENT MODAL                         -->
<!-- ═══════════════════════════════════════════ -->
<div class="modal" id="createModal">
  <div class="modal-box">
    <h2>➕ Add New Client</h2>
    <div class="form-row">
      <div class="form-group"><label>Owner Name *</label><input id="f_name" placeholder="Rahul Sharma"></div>
      <div class="form-group"><label>Business Name *</label><input id="f_business" placeholder="Dr. Sharma Clinic"></div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Business Type</label>
        <select id="f_type">
          <option value="clinic">🏥 Clinic / Doctor</option>
          <option value="salon">💇 Salon / Spa</option>
          <option value="tutor">📚 Tutor / Coaching</option>
          <option value="restaurant">🍽️ Restaurant / Cafe</option>
          <option value="gym">💪 Gym / Fitness</option>
          <option value="generic">🏢 Generic Business</option>
        </select>
      </div>
      <div class="form-group"><label>WhatsApp Number * (with country code)</label><input id="f_wa" placeholder="919876543210" type="tel"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Owner Phone</label><input id="f_phone" placeholder="9876543210" type="tel"></div>
      <div class="form-group">
        <label>Timezone</label>
        <select id="f_tz">
          <option value="Asia/Kolkata">🇮🇳 Asia/Kolkata (IST)</option>
          <option value="Asia/Dubai">🇦🇪 Asia/Dubai (GST)</option>
          <option value="Asia/Singapore">🇸🇬 Asia/Singapore (SGT)</option>
          <option value="America/New_York">🇺🇸 America/New_York</option>
          <option value="Europe/London">🇬🇧 Europe/London</option>
        </select>
      </div>
    </div>

    <div class="form-group">
      <label>Access Key (auto-generated — share with client for dashboard login)</label>
      <div style="display:flex;gap:8px">
        <input id="f_apiKey" placeholder="Leave blank to auto-generate" style="flex:1">
        <button type="button" class="btn btn-gray" style="padding:9px 14px;font-size:12px" onclick="genKey()">🔄 Generate</button>
      </div>
    </div>

    <div class="form-group">
      <label>Trial / Plan Period</label>
      <div class="trial-grid" id="trialGrid">
        <div class="trial-opt" onclick="selectTrial(this,'days',7,0)" data-unit="days" data-val="7">
          <div class="days">7 Days</div>
          <div class="label">Free Trial</div>
          <div class="price">₹0</div>
        </div>
        <div class="trial-opt" onclick="selectTrial(this,'days',15,500)" data-unit="days" data-val="15">
          <div class="days">15 Days</div>
          <div class="label">Half Month</div>
          <div class="price">₹500</div>
        </div>
        <div class="trial-opt selected" onclick="selectTrial(this,'months',1,1000)" data-unit="months" data-val="1">
          <div class="days">1 Month</div>
          <div class="label">Standard</div>
          <div class="price">₹1000</div>
        </div>
        <div class="trial-opt" onclick="selectTrial(this,'months',3,2500)" data-unit="months" data-val="3">
          <div class="days">3 Months</div>
          <div class="label">Quarterly</div>
          <div class="price">₹2500</div>
        </div>
        <div class="trial-opt" onclick="selectTrial(this,'months',6,4500)" data-unit="months" data-val="6">
          <div class="days">6 Months</div>
          <div class="label">Half Year</div>
          <div class="price">₹4500</div>
        </div>
        <div class="trial-opt" onclick="selectTrial(this,'months',12,8000)" data-unit="months" data-val="12">
          <div class="days">12 Months</div>
          <div class="label">Annual</div>
          <div class="price">₹8000</div>
        </div>
      </div>
      <input type="hidden" id="f_trialUnit" value="months">
      <input type="hidden" id="f_trialVal" value="1">
      <input type="hidden" id="f_trialAmount" value="1000">
    </div>

    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-gray btn-lg" onclick="closeCreateModal()">Cancel</button>
      <button class="btn btn-primary btn-lg" onclick="createClient()">Create & Start Bot →</button>
    </div>
  </div>
</div>

<!-- ═══════════════════════════════════════════ -->
<!-- EDIT CLIENT MODAL                           -->
<!-- ═══════════════════════════════════════════ -->
<div class="modal" id="editModal">
  <div class="modal-box">
    <h2>✏️ Edit Client</h2>
    <input type="hidden" id="edit_id">
    <div class="form-row">
      <div class="form-group"><label>Owner Name</label><input id="edit_name" placeholder="Rahul Sharma"></div>
      <div class="form-group"><label>Business Name</label><input id="edit_business" placeholder="Clinic Name"></div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Business Type</label>
        <select id="edit_type">
          <option value="clinic">🏥 Clinic / Doctor</option>
          <option value="salon">💇 Salon / Spa</option>
          <option value="tutor">📚 Tutor / Coaching</option>
          <option value="restaurant">🍽️ Restaurant / Cafe</option>
          <option value="gym">💪 Gym / Fitness</option>
          <option value="generic">🏢 Generic Business</option>
        </select>
      </div>
      <div class="form-group"><label>WhatsApp Number (with country code)</label><input id="edit_wa" type="tel"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Owner Phone</label><input id="edit_phone" type="tel"></div>
      <div class="form-group">
        <label>Timezone</label>
        <select id="edit_tz">
          <option value="Asia/Kolkata">🇮🇳 Asia/Kolkata (IST)</option>
          <option value="Asia/Dubai">🇦🇪 Asia/Dubai (GST)</option>
          <option value="Asia/Singapore">🇸🇬 Asia/Singapore (SGT)</option>
          <option value="America/New_York">🇺🇸 America/New_York</option>
          <option value="Europe/London">🇬🇧 Europe/London</option>
        </select>
      </div>
    </div>

    <div class="form-group">
      <label>Access Key (dashboard login key for client)</label>
      <div class="key-box" id="edit_keyBox">
        <span id="edit_keyText">—</span>
        <button class="copy-btn" onclick="copyKey('edit_keyText')">📋 Copy</button>
      </div>
      <button class="btn btn-warning" style="margin-top:8px;font-size:12px" onclick="resetKey()">🔄 Generate New Key</button>
      <span style="font-size:11px;color:#94a3b8;margin-left:8px">(Old key will stop working)</span>
    </div>

    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-gray btn-lg" onclick="closeEditModal()">Cancel</button>
      <button class="btn btn-primary btn-lg" onclick="submitEdit()">💾 Save Changes</button>
    </div>
  </div>
</div>

<!-- ═══════════════════════════════════════════ -->
<!-- QR MODAL                                    -->
<!-- ═══════════════════════════════════════════ -->
<div class="modal" id="qrModal">
  <div class="modal-box" style="text-align:center;max-width:360px">
    <h2 id="qrTitle">📱 Scan QR Code</h2>
    <p style="color:#94a3b8;font-size:13px;margin-bottom:20px">WhatsApp → ⋮ → Linked Devices → Link a Device</p>
    <div id="qrContainer"><p style="color:#94a3b8">Loading QR...</p></div>
    <p id="qrStatus" style="margin-top:12px;font-size:13px;color:#fbbf24"></p>
    <button class="btn btn-gray btn-lg" style="margin-top:16px" onclick="closeQRModal()">Close</button>
  </div>
</div>

<!-- ═══════════════════════════════════════════ -->
<!-- RENEW MODAL                                 -->
<!-- ═══════════════════════════════════════════ -->
<div class="modal" id="renewModal">
  <div class="modal-box" style="max-width:420px">
    <h2>🔄 Renew License</h2>
    <input type="hidden" id="renewClientId">
    <div class="form-group">
      <label>Select Plan</label>
      <div class="trial-grid" id="renewGrid">
        <div class="trial-opt" onclick="selectRenew(this,'days',7,0)"><div class="days">7 Days</div><div class="label">Trial</div><div class="price">₹0</div></div>
        <div class="trial-opt" onclick="selectRenew(this,'days',15,500)"><div class="days">15 Days</div><div class="label">Half Month</div><div class="price">₹500</div></div>
        <div class="trial-opt selected" onclick="selectRenew(this,'months',1,1000)"><div class="days">1 Month</div><div class="label">Standard</div><div class="price">₹1000</div></div>
        <div class="trial-opt" onclick="selectRenew(this,'months',3,2500)"><div class="days">3 Months</div><div class="label">Quarterly</div><div class="price">₹2500</div></div>
        <div class="trial-opt" onclick="selectRenew(this,'months',6,4500)"><div class="days">6 Months</div><div class="label">Half Year</div><div class="price">₹4500</div></div>
        <div class="trial-opt" onclick="selectRenew(this,'months',12,8000)"><div class="days">12 Months</div><div class="label">Annual</div><div class="price">₹8000</div></div>
      </div>
      <input type="hidden" id="r_unit" value="months">
      <input type="hidden" id="r_val" value="1">
      <input type="hidden" id="r_amount" value="1000">
    </div>
    <div class="form-row">
      <div class="form-group"><label>Amount Received (₹)</label><input id="renewAmount" type="number" value="1000"></div>
      <div class="form-group"><label>Payment Note</label><input id="renewNote" placeholder="UPI / Cash / GPay"></div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-gray btn-lg" onclick="document.getElementById('renewModal').classList.remove('open')">Cancel</button>
      <button class="btn btn-success btn-lg" onclick="submitRenew()">Renew →</button>
    </div>
  </div>
</div>

<!-- ═══════════════════════════════════════════ -->
<!-- HOW TO TEST GUIDE MODAL                     -->
<!-- ═══════════════════════════════════════════ -->
<div class="modal" id="testModal">
  <div class="modal-box" style="max-width:560px">
    <h2>🧪 How to Test Your Bot</h2>
    <div class="test-steps">

      <div class="test-step">
        <div class="step-num">1</div>
        <div class="step-text">
          <strong>Client banao (already kiya hai toh skip karo)</strong><br>
          "Add Client" button se ek test client banao. WhatsApp number apna khud ka daal do.
        </div>
      </div>

      <div class="test-step">
        <div class="step-num">2</div>
        <div class="step-text">
          <strong>WhatsApp connect karo</strong><br>
          Table mein <code>QR</code> button dabao → apne phone pe WhatsApp kholo → ⋮ → Linked Devices → Link a Device → QR scan karo.
          Status <code>ready</code> ho jaayega.
        </div>
      </div>

      <div class="test-step">
        <div class="step-num">3</div>
        <div class="step-text">
          <strong>Apne aap se message karo</strong><br>
          Doosre phone se ya <a href="https://wa.me/" target="_blank" style="color:#6366f1">wa.me</a> se us WhatsApp number pe message karo jisse bot connect hai.<br>
          <code>Hi</code> ya <code>Hello</code> bhejo — bot reply karega.
        </div>
      </div>

      <div class="test-step">
        <div class="step-num">4</div>
        <div class="step-text">
          <strong>Client Dashboard test karo</strong><br>
          Table mein <code>✏️ Edit</code> → Access Key copy karo →
          <code>/dashboard/login</code> pe jaao → woh key paste karo.
          Business owner wali view dikhegi.
        </div>
      </div>

      <div class="test-step">
        <div class="step-num">5</div>
        <div class="step-text">
          <strong>Live messages dekho</strong><br>
          Is page ke neeche "Live Messages" section mein real-time messages dikhenge jab bhi koi message aayega.
        </div>
      </div>

      <div class="test-step">
        <div class="step-num">6</div>
        <div class="step-text">
          <strong>AI test karo</strong><br>
          Railway Variables mein <code>GEMINI_API_KEY</code> add karo (free — aistudio.google.com se lao).<br>
          Phir bot se kuch complex question poocho jaise <em>"Do you accept insurance?"</em> — AI reply karega.
        </div>
      </div>

    </div>
    <div style="text-align:right;margin-top:16px">
      <button class="btn btn-primary btn-lg" onclick="document.getElementById('testModal').classList.remove('open')">Got it ✓</button>
    </div>
  </div>
</div>

<script>
// ── Socket.IO live feed ───────────────────────────────────────────
const socket = io();
socket.on('new_message', data => {
  const log = document.getElementById('liveLog');
  if (log.querySelector('span')) log.innerHTML = '';
  const line = document.createElement('div');
  line.innerHTML = '<span style="color:#475569">[' + new Date().toLocaleTimeString() + ']</span> '
    + '<span style="color:#fbbf24">' + (data.name || data.from) + '</span>: '
    + '<span style="color:#e2e8f0">' + (data.message || '').slice(0, 80) + '</span>';
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  if (log.children.length > 60) log.removeChild(log.firstChild);
});
socket.on('status_update', () => refreshClients());

// ── Modal helpers ─────────────────────────────────────────────────
function openCreateModal() {
  genKey();
  document.getElementById('createModal').classList.add('open');
}
function closeCreateModal() { document.getElementById('createModal').classList.remove('open'); }
function closeEditModal()   { document.getElementById('editModal').classList.remove('open'); }
function closeQRModal()     { document.getElementById('qrModal').classList.remove('open'); }
function openTestGuide()    { document.getElementById('testModal').classList.add('open'); }

// ── Auto-generate API key ─────────────────────────────────────────
function genKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = 'KEY-';
  for (let i = 0; i < 16; i++) key += chars[Math.floor(Math.random() * chars.length)];
  document.getElementById('f_apiKey').value = key;
}

function copyKey(elId) {
  const text = document.getElementById(elId).textContent;
  navigator.clipboard.writeText(text).then(() => alert('✅ Key copied!'));
}

// ── Trial period selection ────────────────────────────────────────
function selectTrial(el, unit, val, amount) {
  document.querySelectorAll('#trialGrid .trial-opt').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('f_trialUnit').value = unit;
  document.getElementById('f_trialVal').value = val;
  document.getElementById('f_trialAmount').value = amount;
  if (!document.getElementById('f_apiKey').value) genKey();
}

function selectRenew(el, unit, val, amount) {
  document.querySelectorAll('#renewGrid .trial-opt').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('r_unit').value = unit;
  document.getElementById('r_val').value = val;
  document.getElementById('r_amount').value = amount;
  document.getElementById('renewAmount').value = amount;
}

// ── Create Client ─────────────────────────────────────────────────
async function createClient() {
  const name = document.getElementById('f_name').value.trim();
  const businessName = document.getElementById('f_business').value.trim();
  const whatsappNumber = document.getElementById('f_wa').value.trim();
  if (!name || !businessName || !whatsappNumber) { alert('Name, Business Name aur WhatsApp Number required hai!'); return; }

  const unit = document.getElementById('f_trialUnit').value;
  const val = parseInt(document.getElementById('f_trialVal').value);

  const body = {
    name,
    businessName,
    businessType: document.getElementById('f_type').value,
    whatsappNumber,
    phone: document.getElementById('f_phone').value,
    apiKey: document.getElementById('f_apiKey').value,
    timezone: document.getElementById('f_tz').value,
    monthsPaid: unit === 'months' ? val : 0,
    daysPaid: unit === 'days' ? val : 0,
    amount: parseInt(document.getElementById('f_trialAmount').value)
  };

  const r = await fetch('/admin/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (d.success) {
    closeCreateModal();
    alert('✅ Client created! Access Key: ' + d.client.apiKey + '\\n\\nYe key client ko do dashboard login ke liye.');
    setTimeout(() => showQR(d.client.id, d.client.businessName), 2000);
    refreshClients();
  } else {
    alert('❌ Error: ' + d.error);
  }
}

// ── Edit Client ───────────────────────────────────────────────────
function openEdit(c) {
  document.getElementById('edit_id').value = c.id;
  document.getElementById('edit_name').value = c.name || '';
  document.getElementById('edit_business').value = c.businessName || '';
  document.getElementById('edit_type').value = c.businessType || 'generic';
  document.getElementById('edit_wa').value = c.whatsappNumber || '';
  document.getElementById('edit_phone').value = c.phone || '';
  document.getElementById('edit_tz').value = c.timezone || 'Asia/Kolkata';
  document.getElementById('edit_keyText').textContent = c.apiKey || '(not set)';
  document.getElementById('editModal').classList.add('open');
}

async function submitEdit() {
  const id = document.getElementById('edit_id').value;
  const body = {
    name: document.getElementById('edit_name').value,
    businessName: document.getElementById('edit_business').value,
    businessType: document.getElementById('edit_type').value,
    whatsappNumber: document.getElementById('edit_wa').value,
    phone: document.getElementById('edit_phone').value,
    timezone: document.getElementById('edit_tz').value
  };
  const r = await fetch('/admin/api/clients/' + id + '/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (d.success) { closeEditModal(); refreshClients(); alert('✅ Client updated!'); }
  else alert('❌ Error: ' + d.error);
}

async function resetKey() {
  const id = document.getElementById('edit_id').value;
  if (!confirm('Old key band ho jaayegi. Continue?')) return;
  const r = await fetch('/admin/api/clients/' + id + '/reset-key', { method: 'POST' });
  const d = await r.json();
  if (d.success) {
    document.getElementById('edit_keyText').textContent = d.apiKey;
    alert('✅ New Key: ' + d.apiKey + '\\n\\nYe client ko bhejo!');
  }
}

// ── QR Modal ──────────────────────────────────────────────────────
let qrPollInterval = null;
async function showQR(clientId, name) {
  if (qrPollInterval) clearInterval(qrPollInterval);
  document.getElementById('qrTitle').textContent = '📱 ' + name;
  document.getElementById('qrModal').classList.add('open');
  document.getElementById('qrContainer').innerHTML = '<p style="color:#94a3b8">Loading...</p>';

  qrPollInterval = setInterval(async () => {
    const r = await fetch('/admin/api/sessions/' + clientId + '/qr');
    const d = await r.json();
    document.getElementById('qrStatus').textContent = 'Status: ' + d.status;
    if (d.status === 'ready') {
      clearInterval(qrPollInterval);
      document.getElementById('qrContainer').innerHTML = '<p style="color:#4ade80;font-size:22px;padding:20px">✅ Connected!</p>';
    } else if (d.qr) {
      document.getElementById('qrContainer').innerHTML = '<img src="' + d.qr + '" style="max-width:240px;border-radius:8px">';
    } else {
      document.getElementById('qrContainer').innerHTML = '<p style="color:#94a3b8;padding:20px">Initializing... (' + d.status + ')</p>';
    }
  }, 3000);
}

// ── Renew ─────────────────────────────────────────────────────────
function openRenew(id) {
  document.getElementById('renewClientId').value = id;
  document.getElementById('renewModal').classList.add('open');
}

async function submitRenew() {
  const id = document.getElementById('renewClientId').value;
  const unit = document.getElementById('r_unit').value;
  const val = parseInt(document.getElementById('r_val').value);
  const amount = parseInt(document.getElementById('renewAmount').value);
  const note = document.getElementById('renewNote').value;

  const body = unit === 'days'
    ? { days: val, amount, note }
    : { months: val, amount, note };

  await fetch('/admin/api/clients/' + id + '/renew', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  document.getElementById('renewModal').classList.remove('open');
  refreshClients();
  alert('✅ License renewed!');
}

// ── Status toggle ─────────────────────────────────────────────────
async function toggleStatus(id, newStatus) {
  if (!confirm('Status change karein to "' + newStatus + '"?')) return;
  await fetch('/admin/api/clients/' + id + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: newStatus }) });
  refreshClients();
}

// ── Restart session ───────────────────────────────────────────────
async function restartSession(id) {
  await fetch('/admin/api/sessions/' + id + '/restart', { method: 'POST' });
  alert('↺ Restart initiated. QR 30 sec mein aayega.');
}

// ── Refresh table ─────────────────────────────────────────────────
async function refreshClients() {
  const r = await fetch('/admin/api/clients');
  const clients = await r.json();
  document.getElementById('clientsBody').innerHTML = clients
    .filter(c => c.status !== 'deleted')
    .map(c => \`
    <tr>
      <td>
        <strong style="color:#fff">\${c.businessName}</strong><br>
        <span style="font-size:11px;color:#64748b">\${c.name} · \${c.whatsappNumber}</span>
      </td>
      <td style="text-transform:capitalize;font-size:12px">\${c.businessType}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <code style="font-size:11px;color:#fbbf24;background:#0f172a;padding:3px 8px;border-radius:4px;\${c.apiKey ? '' : 'color:#ef4444'}">\${c.apiKey ? c.apiKey.slice(0,18) + '…' : 'NOT SET'}</code>
          <button class="copy-btn" onclick="navigator.clipboard.writeText('\${c.apiKey || ''}').then(()=>alert('Copied!'))">📋</button>
        </div>
      </td>
      <td style="font-size:12px">
        \${new Date(c.expiryDate).toLocaleDateString('en-IN')}<br>
        <span style="color:\${c.daysLeft < 3 ? '#f87171' : c.daysLeft < 7 ? '#fbbf24' : '#4ade80'}">
          \${c.isExpired ? '⚠️ EXPIRED' : c.daysLeft + 'd left'}
        </span>
      </td>
      <td>
        <span class="badge badge-\${c.waStatus === 'ready' ? 'ready' : c.waStatus === 'qr_pending' ? 'qr' : 'disconnected'}">
          \${c.waStatus || 'not_started'}
        </span>
      </td>
      <td>
        <span class="badge badge-\${c.status === 'active' ? 'active' : c.status === 'suspended' ? 'suspended' : 'expired'}">\${c.status}</span>
      </td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="showQR('\${c.id}','\${c.businessName.replace(/'/g,'')}')">QR</button>
          <button class="btn btn-teal" onclick='openEdit(\${JSON.stringify(c).replace(/'/g,"\\\\'")} )'>✏️</button>
          <button class="btn btn-success" onclick="openRenew('\${c.id}')">Renew</button>
          <button class="btn btn-gray" onclick="restartSession('\${c.id}')">↺</button>
          <button class="btn \${c.status === 'active' ? 'btn-warning' : 'btn-success'}" onclick="toggleStatus('\${c.id}','\${c.status === 'active' ? 'suspended' : 'active'}')">
            \${c.status === 'active' ? '⏸' : '▶'}
          </button>
        </div>
      </td>
    </tr>
  \`).join('');
}

setInterval(refreshClients, 15000);
</script>
</body></html>`;
}

function renderClientRow(c, statuses) {
  const st = statuses[c.id] || {};
  const days = moment(c.expiryDate).diff(moment(), 'days');
  const expired = moment().isAfter(moment(c.expiryDate));
  const waStatus = st.status || 'not_started';

  return `<tr>
    <td>
      <strong style="color:#fff">${c.businessName}</strong><br>
      <span style="font-size:11px;color:#64748b">${c.name} · ${c.whatsappNumber}</span>
    </td>
    <td style="text-transform:capitalize;font-size:12px">${c.businessType}</td>
    <td>
      <div style="display:flex;align-items:center;gap:6px">
        <code style="font-size:11px;color:#fbbf24;background:#0f172a;padding:3px 8px;border-radius:4px;${c.apiKey ? '' : 'color:#ef4444'}">${c.apiKey ? c.apiKey.slice(0, 18) + '…' : 'NOT SET'}</code>
        <button class="copy-btn" onclick="navigator.clipboard.writeText('${c.apiKey || ''}').then(()=>alert('Copied!'))">📋</button>
      </div>
    </td>
    <td style="font-size:12px">
      ${new Date(c.expiryDate).toLocaleDateString('en-IN')}<br>
      <span style="color:${days < 3 ? '#f87171' : days < 7 ? '#fbbf24' : '#4ade80'}">
        ${expired ? '⚠️ EXPIRED' : days + 'd left'}
      </span>
    </td>
    <td>
      <span class="badge ${waStatus === 'ready' ? 'badge-ready' : waStatus === 'qr_pending' ? 'badge-qr' : 'badge-disconnected'}">
        ${waStatus}
      </span>
    </td>
    <td>
      <span class="badge ${c.status === 'active' ? 'badge-active' : c.status === 'suspended' ? 'badge-suspended' : 'badge-expired'}">${c.status}</span>
    </td>
    <td>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="showQR('${c.id}','${c.businessName.replace(/'/g, '')}')">QR</button>
        <button class="btn btn-teal" onclick='openEdit(${JSON.stringify(c)})'>✏️</button>
        <button class="btn btn-success" onclick="openRenew('${c.id}')">Renew</button>
        <button class="btn btn-gray" onclick="restartSession('${c.id}')">↺</button>
        <button class="btn ${c.status === 'active' ? 'btn-warning' : 'btn-success'}" onclick="toggleStatus('${c.id}','${c.status === 'active' ? 'suspended' : 'active'}')">
          ${c.status === 'active' ? '⏸' : '▶'}
        </button>
      </div>
    </td>
  </tr>`;
}

module.exports = router;
