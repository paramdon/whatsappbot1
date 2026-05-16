// src/routes/admin.js
// YOU (the seller) use these routes to manage all clients

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const moment = require('moment');
const db = require('../db/database');
const wa = require('../services/whatsappManager');
const { requireAdmin } = require('../middleware/auth');

// ── Admin Login ───────────────────────────────────────────────────
router.get('/login', (req, res) => {
  res.send(adminLoginPage());
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
    const client = db.createClient(req.body);
    // Start WA session
    wa.startSession(client.id).catch(e => console.error('Session start error:', e.message));
    res.json({ success: true, client });
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
  const { months = 1, amount, note } = req.body;
  const client = db.renewClient(req.params.id, parseInt(months), amount || months * 1000, note);
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

function adminLoginPage() {
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
.error{background:#ef4444;color:#fff;padding:10px;border-radius:8px;text-align:center;margin-bottom:16px;font-size:13px}
</style>
</head>
<body>
<div class="card">
  <h1>🤖 WA Agent Admin</h1>
  <p>Seller dashboard — manage all clients</p>
  ${new URL('http://x' + (global._adminLoginError || '')).searchParams.get('error') === '1' ? '<div class="error">Invalid credentials</div>' : ''}
  <form method="POST" action="/admin/login">
    <label>Username</label>
    <input type="text" name="username" placeholder="admin" required>
    <label>Password</label>
    <input type="password" name="password" placeholder="••••••••" required>
    <button type="submit">Login →</button>
  </form>
</div>
</body></html>`;
}

function adminDashboardPage(clients, statuses, expiring) {
  const active = clients.filter(c => c.status === 'active').length;
  const expired = clients.filter(c => c.status === 'expired').length;
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
.container{padding:24px;max-width:1200px;margin:0 auto}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px}
.stat{background:#1e293b;border-radius:12px;padding:20px;text-align:center}
.stat .num{font-size:28px;font-weight:700;color:#6366f1}
.stat .label{font-size:13px;color:#94a3b8;margin-top:4px}
.section-title{font-size:16px;font-weight:600;color:#fff;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.clients-table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
.clients-table th{background:#334155;padding:12px 16px;text-align:left;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px}
.clients-table td{padding:12px 16px;border-bottom:1px solid #334155;font-size:14px;vertical-align:middle}
.clients-table tr:last-child td{border-bottom:none}
.badge{padding:3px 8px;border-radius:20px;font-size:11px;font-weight:600}
.badge-active{background:#166534;color:#4ade80}
.badge-expired{background:#7f1d1d;color:#f87171}
.badge-ready{background:#1e3a5f;color:#60a5fa}
.badge-qr{background:#713f12;color:#fbbf24}
.badge-suspended{background:#374151;color:#9ca3af}
.btn{padding:6px 12px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600}
.btn-primary{background:#6366f1;color:#fff}
.btn-success{background:#16a34a;color:#fff}
.btn-danger{background:#dc2626;color:#fff}
.btn-warning{background:#d97706;color:#fff}
.btn-sm{padding:4px 8px;font-size:11px}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center}
.modal.open{display:flex}
.modal-box{background:#1e293b;border-radius:16px;padding:32px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto}
.modal-box h2{color:#fff;margin-bottom:20px;font-size:18px}
.form-group{margin-bottom:16px}
.form-group label{display:block;color:#94a3b8;font-size:12px;margin-bottom:6px}
.form-group input,.form-group select{width:100%;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#fff;font-size:14px}
.form-group input:focus,.form-group select:focus{outline:none;border-color:#6366f1}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.qr-modal img{max-width:260px;display:block;margin:0 auto}
.warn-box{background:#451a03;border:1px solid #d97706;border-radius:8px;padding:14px;margin-bottom:16px;font-size:13px;color:#fde68a}
#liveLog{background:#0f172a;border-radius:8px;padding:16px;height:200px;overflow-y:auto;font-size:12px;font-family:monospace;color:#a3e635;margin-top:12px}
</style>
</head>
<body>
<div class="topbar">
  <h1>🤖 WhatsApp Agent — Seller Panel</h1>
  <div style="display:flex;gap:16px;align-items:center">
    <span style="color:#4ade80;font-size:13px">● Live</span>
    <a href="/admin/logout">Logout</a>
  </div>
</div>
<div class="container">

  ${expiring.length > 0 ? `
  <div class="warn-box" style="margin-bottom:20px">
    ⚠️ <strong>${expiring.length} client(s)</strong> expiring soon:
    ${expiring.map(c => `<strong>${c.businessName}</strong> (${moment(c.expiryDate).diff(moment(), 'days')}d left)`).join(', ')}
  </div>` : ''}

  <div class="stats">
    <div class="stat"><div class="num">${clients.length}</div><div class="label">Total Clients</div></div>
    <div class="stat"><div class="num" style="color:#4ade80">${active}</div><div class="label">Active</div></div>
    <div class="stat"><div class="num" style="color:#f87171">${expired}</div><div class="label">Expired</div></div>
    <div class="stat"><div class="num" style="color:#fbbf24">₹${(revenue/1000).toFixed(0)}K</div><div class="label">Total Revenue</div></div>
  </div>

  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div class="section-title">📋 All Clients</div>
    <button class="btn btn-primary" onclick="openCreateModal()">+ Add Client</button>
  </div>

  <table class="clients-table" id="clientsTable">
    <thead>
      <tr>
        <th>Business</th><th>Type</th><th>Expiry</th><th>WA Status</th><th>License</th><th>Actions</th>
      </tr>
    </thead>
    <tbody id="clientsBody">
      ${clients.map(c => renderClientRow(c, statuses)).join('')}
    </tbody>
  </table>

  <div style="margin-top:32px">
    <div class="section-title">📡 Live Activity</div>
    <div id="liveLog">Waiting for messages...</div>
  </div>
</div>

<!-- Create Client Modal -->
<div class="modal" id="createModal">
  <div class="modal-box">
    <h2>Add New Client</h2>
    <div class="form-row">
      <div class="form-group"><label>Owner Name</label><input id="f_name" placeholder="Rahul Sharma"></div>
      <div class="form-group"><label>Business Name</label><input id="f_business" placeholder="Dr. Sharma Clinic"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Business Type</label>
        <select id="f_type">
          <option value="clinic">Clinic / Doctor</option>
          <option value="salon">Salon / Spa</option>
          <option value="tutor">Tutor / Coaching</option>
          <option value="restaurant">Restaurant / Cafe</option>
          <option value="gym">Gym / Fitness</option>
          <option value="generic">Generic Business</option>
        </select>
      </div>
      <div class="form-group"><label>WhatsApp Number (with country code)</label><input id="f_wa" placeholder="919876543210"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Owner Phone</label><input id="f_phone" placeholder="9876543210"></div>
      <div class="form-group"><label>Months (₹1000/mo)</label><input id="f_months" type="number" value="1" min="1" max="12"></div>
    </div>
    <div class="form-group"><label>Timezone</label>
      <select id="f_tz">
        <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
        <option value="Asia/Dubai">Asia/Dubai (GST)</option>
        <option value="Asia/Singapore">Asia/Singapore (SGT)</option>
      </select>
    </div>
    <div style="display:flex;gap:12px;justify-content:flex-end">
      <button class="btn" style="background:#334155;color:#fff" onclick="closeCreateModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createClient()">Create & Start Bot →</button>
    </div>
  </div>
</div>

<!-- QR Modal -->
<div class="modal" id="qrModal">
  <div class="modal-box" style="text-align:center;max-width:340px">
    <h2 id="qrTitle">Scan QR Code</h2>
    <p style="color:#94a3b8;font-size:13px;margin-bottom:20px">Open WhatsApp → Linked Devices → Link a Device</p>
    <div id="qrContainer"><p style="color:#94a3b8">Loading QR...</p></div>
    <p id="qrStatus" style="margin-top:16px;font-size:13px;color:#fbbf24"></p>
    <button class="btn" style="background:#334155;color:#fff;margin-top:16px" onclick="closeQRModal()">Close</button>
  </div>
</div>

<!-- Renew Modal -->
<div class="modal" id="renewModal">
  <div class="modal-box" style="max-width:380px">
    <h2>Renew License</h2>
    <input type="hidden" id="renewClientId">
    <div class="form-group"><label>Months to add</label><input id="renewMonths" type="number" value="1" min="1" max="12"></div>
    <div class="form-group"><label>Amount Received (₹)</label><input id="renewAmount" type="number" value="1000"></div>
    <div class="form-group"><label>Note (optional)</label><input id="renewNote" placeholder="UPI / Cash / GPay"></div>
    <div style="display:flex;gap:12px;justify-content:flex-end">
      <button class="btn" style="background:#334155;color:#fff" onclick="document.getElementById('renewModal').classList.remove('open')">Cancel</button>
      <button class="btn btn-success" onclick="submitRenew()">Renew →</button>
    </div>
  </div>
</div>

<script>
const socket = io();
socket.on('connect', () => console.log('Live connected'));
socket.on('new_message', data => {
  const log = document.getElementById('liveLog');
  const line = document.createElement('div');
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + data.clientId.slice(0,8) + ' | ' + data.name + ': ' + data.message.slice(0,60);
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  if (log.children.length > 50) log.removeChild(log.firstChild);
});
socket.on('status_update', data => {
  refreshClients();
});

function openCreateModal() { document.getElementById('createModal').classList.add('open'); }
function closeCreateModal() { document.getElementById('createModal').classList.remove('open'); }
function closeQRModal() { document.getElementById('qrModal').classList.remove('open'); }

async function createClient() {
  const body = {
    name: document.getElementById('f_name').value,
    businessName: document.getElementById('f_business').value,
    businessType: document.getElementById('f_type').value,
    whatsappNumber: document.getElementById('f_wa').value,
    phone: document.getElementById('f_phone').value,
    monthsPaid: parseInt(document.getElementById('f_months').value),
    timezone: document.getElementById('f_tz').value
  };
  if (!body.name || !body.businessName || !body.whatsappNumber) { alert('Fill all required fields'); return; }
  const r = await fetch('/admin/clients', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const d = await r.json();
  if (d.success) {
    closeCreateModal();
    setTimeout(() => showQR(d.client.id, d.client.businessName), 3000);
    refreshClients();
  } else alert('Error: ' + d.error);
}

async function showQR(clientId, name) {
  document.getElementById('qrTitle').textContent = 'Scan QR — ' + name;
  document.getElementById('qrModal').classList.add('open');
  document.getElementById('qrContainer').innerHTML = '<p style="color:#94a3b8">Loading...</p>';
  const poll = setInterval(async () => {
    const r = await fetch('/admin/api/sessions/' + clientId + '/qr');
    const d = await r.json();
    document.getElementById('qrStatus').textContent = 'Status: ' + d.status;
    if (d.qr) {
      document.getElementById('qrContainer').innerHTML = '<img src="' + d.qr + '" style="max-width:240px">';
    }
    if (d.status === 'ready') {
      clearInterval(poll);
      document.getElementById('qrContainer').innerHTML = '<p style="color:#4ade80;font-size:20px">✅ Connected!</p>';
    }
  }, 3000);
}

function openRenew(id, name) {
  document.getElementById('renewClientId').value = id;
  document.getElementById('renewModal').classList.add('open');
}

async function submitRenew() {
  const id = document.getElementById('renewClientId').value;
  const months = parseInt(document.getElementById('renewMonths').value);
  const amount = parseInt(document.getElementById('renewAmount').value);
  const note = document.getElementById('renewNote').value;
  await fetch('/admin/api/clients/' + id + '/renew', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({months,amount,note}) });
  document.getElementById('renewModal').classList.remove('open');
  refreshClients();
}

async function toggleStatus(id, newStatus) {
  if (!confirm('Change status to ' + newStatus + '?')) return;
  await fetch('/admin/api/clients/' + id + '/status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({status:newStatus}) });
  refreshClients();
}

async function restartSession(id) {
  await fetch('/admin/api/sessions/' + id + '/restart', { method:'POST' });
  alert('Restart initiated');
}

async function refreshClients() {
  const r = await fetch('/admin/api/clients');
  const clients = await r.json();
  document.getElementById('clientsBody').innerHTML = clients.map(c => \`
    <tr>
      <td><strong>\${c.businessName}</strong><br><span style="font-size:11px;color:#64748b">\${c.name} · \${c.whatsappNumber}</span></td>
      <td><span style="text-transform:capitalize">\${c.businessType}</span></td>
      <td style="font-size:12px">
        \${new Date(c.expiryDate).toLocaleDateString()}<br>
        <span style="color:\${c.daysLeft < 3 ? '#f87171' : c.daysLeft < 7 ? '#fbbf24' : '#4ade80'}">\${c.isExpired ? 'EXPIRED' : c.daysLeft + 'd left'}</span>
      </td>
      <td><span class="badge \${c.waStatus === 'ready' ? 'badge-ready' : c.waStatus === 'qr_pending' ? 'badge-qr' : 'badge-suspended'}">\${c.waStatus}</span></td>
      <td><span class="badge \${c.status === 'active' ? 'badge-active' : 'badge-expired'}">\${c.status}</span></td>
      <td>
        <button class="btn btn-sm btn-primary" onclick="showQR('\${c.id}','\${c.businessName}')">QR</button>
        <button class="btn btn-sm btn-success" onclick="openRenew('\${c.id}','\${c.businessName}')">Renew</button>
        <button class="btn btn-sm" style="background:#334155;color:#fff" onclick="restartSession('\${c.id}')">↺</button>
        <button class="btn btn-sm \${c.status === 'active' ? 'btn-warning' : 'btn-success'}" onclick="toggleStatus('\${c.id}','\${c.status === 'active' ? 'suspended' : 'active'}')">
          \${c.status === 'active' ? 'Suspend' : 'Activate'}
        </button>
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
  return `<tr>
    <td><strong>${c.businessName}</strong><br><span style="font-size:11px;color:#64748b">${c.name} · ${c.whatsappNumber}</span></td>
    <td style="text-transform:capitalize">${c.businessType}</td>
    <td style="font-size:12px">
      ${new Date(c.expiryDate).toLocaleDateString()}<br>
      <span style="color:${days < 3 ? '#f87171' : days < 7 ? '#fbbf24' : '#4ade80'}">${expired ? 'EXPIRED' : days + 'd left'}</span>
    </td>
    <td><span class="badge ${st.status === 'ready' ? 'badge-ready' : st.status === 'qr_pending' ? 'badge-qr' : 'badge-suspended'}">${st.status || 'not_started'}</span></td>
    <td><span class="badge ${c.status === 'active' ? 'badge-active' : 'badge-expired'}">${c.status}</span></td>
    <td>
      <button class="btn btn-sm btn-primary" onclick="showQR('${c.id}','${c.businessName}')">QR</button>
      <button class="btn btn-sm btn-success" onclick="openRenew('${c.id}','${c.businessName}')">Renew</button>
      <button class="btn btn-sm" style="background:#334155;color:#fff" onclick="restartSession('${c.id}')">↺</button>
    </td>
  </tr>`;
}

module.exports = router;
