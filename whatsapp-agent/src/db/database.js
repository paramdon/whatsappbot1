// src/db/database.js
// Zero-config JSON database — works on free Render disk

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const moment = require('moment');

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Master DB (admin, clients, licenses) ────────────────────────────
const masterAdapter = new FileSync(path.join(DATA_DIR, 'master.json'));
const masterDB = low(masterAdapter);

masterDB.defaults({
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'changeme123', 10)
  },
  clients: [],
  global_stats: { total_messages: 0, total_appointments: 0 }
}).write();

// ── Per-client DB factory ────────────────────────────────────────────
const clientDBs = {};

function getClientDB(clientId) {
  if (clientDBs[clientId]) return clientDBs[clientId];
  const dir = path.join(DATA_DIR, 'clients', clientId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const adapter = new FileSync(path.join(dir, 'data.json'));
  const db = low(adapter);
  db.defaults({
    appointments: [],
    conversations: [],
    blocked_users: [],
    stats: { messages_today: 0, appointments_this_month: 0, last_reset: new Date().toDateString() }
  }).write();
  clientDBs[clientId] = db;
  return db;
}

// ════════════════════════════════════════════════════════════════════
// CLIENT MANAGEMENT
// ════════════════════════════════════════════════════════════════════

function createClient({
  name, businessName, businessType, phone,
  whatsappNumber, apiKey, timezone = 'Asia/Kolkata',
  monthsPaid = 1
}) {
  const id = uuidv4();
  const now = moment();
  const expiry = now.clone().add(monthsPaid, 'months');

  const client = {
    id,
    name,
    businessName,
    businessType, // clinic | salon | tutor | restaurant | gym | generic
    phone,
    whatsappNumber,
    apiKey,           // client's own API key (optional override)
    timezone,
    status: 'active', // active | expired | suspended
    createdAt: now.toISOString(),
    expiryDate: expiry.toISOString(),
    paidMonths: monthsPaid,
    paymentHistory: [{
      date: now.toISOString(),
      months: monthsPaid,
      amount: monthsPaid * 1000,
      note: 'Initial activation'
    }],
    sessionConnected: false,
    lastSeen: null,
    config: getDefaultConfig(businessType, businessName)
  };

  masterDB.get('clients').push(client).write();
  getClientDB(id); // init client DB
  return client;
}

function getDefaultConfig(businessType, businessName) {
  const base = {
    botName: 'Assistant',
    welcomeMessage: `Namaste! 🙏 Welcome to *${businessName}*. I'm your virtual assistant. How can I help you today?`,
    language: 'auto',
    workingHours: { start: '09:00', end: '18:00', days: [1,2,3,4,5,6] },
    offHoursMessage: 'We are currently closed. Our working hours are {start} to {end}. We will respond when we reopen! 🙏',
    services: [],
    slotDuration: 30,
    maxDailySlots: 20,
    breakTime: { start: '13:00', end: '14:00' },
    autoConfirm: true,
    reminderEnabled: true,
    reminderHours: 2,
    ownerNotify: true,
    collectName: true,
    collectPhone: true,
    collectNotes: false,
    keywords: {},
    faqs: []
  };

  const presets = {
    clinic: {
      botName: 'Dr. Assistant',
      services: [
        { id: 's1', name: 'General Consultation', duration: 30, fee: 300 },
        { id: 's2', name: 'Follow-up Visit', duration: 15, fee: 150 },
        { id: 's3', name: 'Report Discussion', duration: 20, fee: 200 }
      ],
      collectNotes: true,
      slotDuration: 30,
      faqs: [
        { q: 'do you accept insurance', a: 'Please call us to check insurance coverage.' },
        { q: 'emergency', a: 'For emergencies please call 108 or visit nearest hospital.' }
      ],
      keywords: { cancel: 'cancel|rebook|reschedule', appointment: 'appointment|booking|slot|time|schedule' }
    },
    salon: {
      botName: 'Beauty Assistant',
      services: [
        { id: 's1', name: 'Haircut', duration: 45, fee: 300 },
        { id: 's2', name: 'Facial', duration: 60, fee: 500 },
        { id: 's3', name: 'Hair Color', duration: 90, fee: 1200 },
        { id: 's4', name: 'Manicure & Pedicure', duration: 60, fee: 600 }
      ],
      slotDuration: 45,
      faqs: [
        { q: 'parking', a: 'Yes, free parking is available outside.' },
        { q: 'products', a: 'We use branded products only — Loreal, Wella, OPI.' }
      ],
      keywords: { cancel: 'cancel|reschedule', appointment: 'book|appointment|slot|service' }
    },
    tutor: {
      botName: 'Study Assistant',
      services: [
        { id: 's1', name: 'Demo Class (Free)', duration: 60, fee: 0 },
        { id: 's2', name: '1-on-1 Session', duration: 60, fee: 500 },
        { id: 's3', name: 'Doubt Session', duration: 30, fee: 200 }
      ],
      workingHours: { start: '07:00', end: '21:00', days: [1,2,3,4,5,6,0] },
      slotDuration: 60,
      collectNotes: true,
      faqs: [
        { q: 'subjects', a: 'We cover Maths, Science, English for classes 6–12 and competitive exams.' },
        { q: 'online', a: 'Yes! We conduct classes on Zoom/Google Meet.' }
      ],
      keywords: { cancel: 'cancel|reschedule', appointment: 'class|session|demo|book|slot' }
    },
    restaurant: {
      botName: 'Table Assistant',
      services: [
        { id: 's1', name: 'Table for 2', duration: 60, fee: 0 },
        { id: 's2', name: 'Table for 4', duration: 90, fee: 0 },
        { id: 's3', name: 'Private Dining', duration: 120, fee: 500 }
      ],
      slotDuration: 60,
      collectNotes: true,
      faqs: [
        { q: 'menu', a: 'Our menu is available at our website. We serve North Indian, Chinese & Continental.' },
        { q: 'parking', a: 'Valet parking available on weekends.' }
      ],
      keywords: { cancel: 'cancel|reschedule', appointment: 'table|reservation|book|dine|reserve' }
    },
    gym: {
      botName: 'Fitness Assistant',
      services: [
        { id: 's1', name: 'Trial Session (Free)', duration: 60, fee: 0 },
        { id: 's2', name: 'Personal Training', duration: 60, fee: 800 },
        { id: 's3', name: 'Diet Consultation', duration: 45, fee: 500 }
      ],
      workingHours: { start: '06:00', end: '22:00', days: [1,2,3,4,5,6,0] },
      slotDuration: 60,
      faqs: [
        { q: 'membership', a: 'Monthly ₹999, Quarterly ₹2499, Annual ₹7999. DM for details!' },
        { q: 'trainer', a: 'Yes, certified personal trainers are available.' }
      ],
      keywords: { cancel: 'cancel|reschedule', appointment: 'session|trial|book|training|consult' }
    },
    generic: {
      botName: 'Business Assistant',
      services: [
        { id: 's1', name: 'Consultation', duration: 30, fee: 0 },
        { id: 's2', name: 'Service Appointment', duration: 60, fee: 0 }
      ],
      faqs: [],
      keywords: { cancel: 'cancel|reschedule', appointment: 'appointment|book|schedule|meet' }
    }
  };

  const preset = presets[businessType] || presets.generic;
  return { ...base, ...preset };
}

function getAllClients() {
  return masterDB.get('clients').value();
}

function getClient(clientId) {
  return masterDB.get('clients').find({ id: clientId }).value();
}

function updateClient(clientId, updates) {
  masterDB.get('clients').find({ id: clientId }).assign(updates).write();
}

function updateClientConfig(clientId, configUpdates) {
  const client = getClient(clientId);
  const newConfig = { ...client.config, ...configUpdates };
  masterDB.get('clients').find({ id: clientId }).assign({ config: newConfig }).write();
  return newConfig;
}

function renewClient(clientId, months, amount, note = '') {
  const client = getClient(clientId);
  const currentExpiry = moment(client.expiryDate);
  const base = currentExpiry.isAfter(moment()) ? currentExpiry : moment();
  const newExpiry = base.clone().add(months, 'months');

  const payment = {
    date: new Date().toISOString(),
    months,
    amount,
    note
  };

  masterDB.get('clients').find({ id: clientId }).assign({
    expiryDate: newExpiry.toISOString(),
    status: 'active',
    paidMonths: (client.paidMonths || 0) + months
  }).write();

  masterDB.get('clients').find({ id: clientId })
    .get('paymentHistory').push(payment).write();

  return getClient(clientId);
}

function isClientActive(clientId) {
  const client = getClient(clientId);
  if (!client) return false;
  if (client.status !== 'active') return false;
  return moment().isBefore(moment(client.expiryDate));
}

function getExpiringClients(days = 3) {
  const threshold = moment().add(days, 'days');
  return masterDB.get('clients').value().filter(c => {
    if (c.status !== 'active') return false;
    return moment(c.expiryDate).isBefore(threshold) && moment(c.expiryDate).isAfter(moment());
  });
}

// ════════════════════════════════════════════════════════════════════
// APPOINTMENT MANAGEMENT
// ════════════════════════════════════════════════════════════════════

function createAppointment(clientId, { userPhone, userName, serviceId, date, time, notes = '' }) {
  const db = getClientDB(clientId);
  const client = getClient(clientId);
  const service = client.config.services.find(s => s.id === serviceId);

  const appt = {
    id: uuidv4(),
    userPhone,
    userName,
    serviceId,
    serviceName: service ? service.name : 'Appointment',
    fee: service ? service.fee : 0,
    date,
    time,
    notes,
    status: 'confirmed', // confirmed | cancelled | completed | no-show
    createdAt: new Date().toISOString(),
    reminderSent: false
  };

  db.get('appointments').push(appt).write();
  return appt;
}

function getAppointmentsByDate(clientId, date) {
  const db = getClientDB(clientId);
  return db.get('appointments').filter({ date, status: 'confirmed' }).value();
}

function getAllAppointments(clientId, filters = {}) {
  const db = getClientDB(clientId);
  let query = db.get('appointments');
  if (filters.status) query = query.filter({ status: filters.status });
  if (filters.date) query = query.filter({ date: filters.date });
  if (filters.userPhone) query = query.filter({ userPhone: filters.userPhone });
  return query.sortBy('date').reverse().take(filters.limit || 100).value();
}

function updateAppointment(clientId, apptId, updates) {
  const db = getClientDB(clientId);
  db.get('appointments').find({ id: apptId }).assign(updates).write();
}

function cancelAppointment(clientId, apptId) {
  updateAppointment(clientId, apptId, { status: 'cancelled' });
}

function getAvailableSlots(clientId, date) {
  const client = getClient(clientId);
  const cfg = client.config;
  const dayOfWeek = moment(date, 'YYYY-MM-DD').day();

  if (!cfg.workingHours.days.includes(dayOfWeek)) return [];

  const slots = [];
  let current = moment(`${date} ${cfg.workingHours.start}`, 'YYYY-MM-DD HH:mm');
  const end = moment(`${date} ${cfg.workingHours.end}`, 'YYYY-MM-DD HH:mm');
  const breakStart = cfg.breakTime ? moment(`${date} ${cfg.breakTime.start}`, 'YYYY-MM-DD HH:mm') : null;
  const breakEnd = cfg.breakTime ? moment(`${date} ${cfg.breakTime.end}`, 'YYYY-MM-DD HH:mm') : null;

  while (current.isBefore(end)) {
    if (breakStart && current.isSameOrAfter(breakStart) && current.isBefore(breakEnd)) {
      current.add(cfg.slotDuration, 'minutes');
      continue;
    }
    slots.push(current.format('HH:mm'));
    current.add(cfg.slotDuration, 'minutes');
  }

  // Remove booked slots
  const booked = getAppointmentsByDate(clientId, date).map(a => a.time);
  return slots.filter(s => !booked.includes(s));
}

// ════════════════════════════════════════════════════════════════════
// CONVERSATION STATE
// ════════════════════════════════════════════════════════════════════

function getConversation(clientId, userPhone) {
  const db = getClientDB(clientId);
  return db.get('conversations').find({ userPhone }).value() || null;
}

function setConversation(clientId, userPhone, state) {
  const db = getClientDB(clientId);
  const existing = db.get('conversations').find({ userPhone }).value();
  if (existing) {
    db.get('conversations').find({ userPhone }).assign({ ...state, updatedAt: new Date().toISOString() }).write();
  } else {
    db.get('conversations').push({
      userPhone,
      ...state,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }).write();
  }
}

function clearConversation(clientId, userPhone) {
  const db = getClientDB(clientId);
  db.get('conversations').find({ userPhone }).assign({
    step: null, data: {}, updatedAt: new Date().toISOString()
  }).write();
}

// ════════════════════════════════════════════════════════════════════
// ADMIN AUTH
// ════════════════════════════════════════════════════════════════════

function verifyAdmin(username, password) {
  const admin = masterDB.get('admin').value();
  if (admin.username !== username) return false;
  return bcrypt.compareSync(password, admin.password);
}

module.exports = {
  masterDB, getClientDB,
  createClient, getAllClients, getClient, updateClient,
  updateClientConfig, renewClient, isClientActive, getExpiringClients,
  createAppointment, getAppointmentsByDate, getAllAppointments,
  updateAppointment, cancelAppointment, getAvailableSlots,
  getConversation, setConversation, clearConversation,
  verifyAdmin, getDefaultConfig
};
