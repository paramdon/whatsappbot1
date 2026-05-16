// src/agent/appointmentAgent.js
// The core booking brain — handles multi-turn conversation flows

const moment = require('moment-timezone');
const db = require('../db/database');
const { detectLanguage, classifyIntent, getContextualReply } = require('../services/aiService');

// ════════════════════════════════════════════════════════════════════
// MESSAGE ROUTER — entry point for every incoming WhatsApp message
// ════════════════════════════════════════════════════════════════════

async function handleMessage(clientId, userPhone, userName, messageText) {
  const client = db.getClient(clientId);
  if (!client) return null;

  const cfg = client.config;
  const userPhone_clean = userPhone.replace('@c.us', '').replace(/\D/g, '');

  // ── Expiry check ──────────────────────────────────────────────
  if (!db.isClientActive(clientId)) {
    return '⚠️ This service is currently unavailable. Please contact the business owner.';
  }

  // ── Working hours check ───────────────────────────────────────
  const now = moment().tz(cfg.timezone || 'Asia/Kolkata');
  const dayOk = cfg.workingHours.days.includes(now.day());
  const timeStr = now.format('HH:mm');
  const afterStart = timeStr >= cfg.workingHours.start;
  const beforeEnd = timeStr < cfg.workingHours.end;
  const inHours = dayOk && afterStart && beforeEnd;

  if (!inHours) {
    const msg = cfg.offHoursMessage
      .replace('{start}', cfg.workingHours.start)
      .replace('{end}', cfg.workingHours.end);
    return msg;
  }

  // ── Language detection ────────────────────────────────────────
  const lang = detectLanguage(messageText);

  // ── Get or create conversation state ─────────────────────────
  let conv = db.getConversation(clientId, userPhone_clean);
  if (!conv) {
    conv = { userPhone: userPhone_clean, step: null, data: {}, history: [] };
  }

  // Add to history (last 10 messages)
  conv.history = conv.history || [];
  conv.history.push({ role: 'user', content: messageText });
  if (conv.history.length > 10) conv.history = conv.history.slice(-10);

  // ── Intent classification ─────────────────────────────────────
  const intent = classifyIntent(messageText, cfg.keywords || {});

  let response = null;

  // ── Active booking flow takes priority ───────────────────────
  if (conv.step && conv.step.startsWith('booking_')) {
    response = await handleBookingFlow(clientId, userPhone_clean, userName, messageText, intent, conv, cfg, lang);
  }
  // ── Cancel flow ───────────────────────────────────────────────
  else if (conv.step === 'cancelling') {
    response = await handleCancelFlow(clientId, userPhone_clean, messageText, intent, conv, cfg, lang);
  }
  // ── Top-level intent routing ──────────────────────────────────
  else {
    switch (intent) {
      case 'greet':
        response = buildWelcomeMessage(cfg, lang);
        conv.step = 'main_menu';
        break;

      case 'book':
        response = buildServiceMenu(cfg, lang);
        conv.step = 'booking_service';
        conv.data = {};
        break;

      case 'cancel':
        response = await buildCancelMenu(clientId, userPhone_clean, cfg, lang);
        conv.step = 'cancelling';
        break;

      case 'services':
        response = buildServicesInfo(cfg, lang);
        break;

      case 'hours':
        response = buildHoursInfo(cfg, lang);
        break;

      case 'status':
        response = await buildAppointmentStatus(clientId, userPhone_clean, cfg, lang);
        break;

      case 'bye':
        response = lang === 'hinglish'
          ? `Shukriya! 🙏 Aapka din achha ho! Koi bhi help chahiye toh message karein.`
          : `Thank you! 🙏 Have a great day! Message us anytime you need help.`;
        conv.step = null;
        conv.data = {};
        break;

      case 'main_menu':
      default: {
        // Try AI for unknown/complex queries
        const aiReply = await getContextualReply(cfg, messageText, lang);
        if (aiReply) {
          response = aiReply;
        } else {
          response = buildMainMenu(cfg, lang);
          conv.step = 'main_menu';
        }
      }
    }
  }

  // Save conversation state
  db.setConversation(clientId, userPhone_clean, conv);

  // Add bot response to history
  if (response) {
    conv.history.push({ role: 'assistant', content: response });
  }

  return response;
}

// ════════════════════════════════════════════════════════════════════
// BOOKING FLOW — multi-step state machine
// ════════════════════════════════════════════════════════════════════

async function handleBookingFlow(clientId, userPhone, userName, text, intent, conv, cfg, lang) {
  const step = conv.step;

  // Allow user to cancel booking flow anytime
  if (intent === 'cancel' || /^(back|menu|stop|quit|exit)/i.test(text)) {
    conv.step = null;
    conv.data = {};
    db.setConversation(clientId, userPhone, conv);
    return lang === 'hinglish'
      ? `Ok, booking cancel kar diya. Koi aur help chahiye? 😊`
      : `Okay, booking cancelled. How else can I help you? 😊`;
  }

  // ── Step 1: Service selection ─────────────────────────────────
  if (step === 'booking_service') {
    const services = cfg.services;
    let selectedService = null;

    const numMatch = text.match(/^(\d+)$/);
    if (numMatch) {
      const idx = parseInt(numMatch[1]) - 1;
      selectedService = services[idx] || null;
    } else {
      selectedService = services.find(s =>
        s.name.toLowerCase().includes(text.toLowerCase()) ||
        text.toLowerCase().includes(s.name.toLowerCase().split(' ')[0])
      );
    }

    if (!selectedService) {
      return lang === 'hinglish'
        ? `❌ Valid option choose karein (1-${services.length}):\n\n` + buildServiceMenu(cfg, lang)
        : `❌ Please choose a valid option (1-${services.length}):\n\n` + buildServiceMenu(cfg, lang);
    }

    conv.data.service = selectedService;
    conv.step = 'booking_date';
    db.setConversation(clientId, userPhone, conv);

    const today = moment().tz(cfg.timezone || 'Asia/Kolkata').format('YYYY-MM-DD');
    const tomorrow = moment().tz(cfg.timezone || 'Asia/Kolkata').add(1, 'day').format('YYYY-MM-DD');
    const dayAfter = moment().tz(cfg.timezone || 'Asia/Kolkata').add(2, 'day').format('YYYY-MM-DD');

    return lang === 'hinglish'
      ? `✅ *${selectedService.name}* select kiya! (${selectedService.duration} min, ₹${selectedService.fee})\n\n📅 *Kaunsa din choose karein?*\n\n1️⃣ Aaj (${today})\n2️⃣ Kal (${tomorrow})\n3️⃣ Parso (${dayAfter})\n\nYa date type karein: DD-MM-YYYY`
      : `✅ *${selectedService.name}* selected! (${selectedService.duration} min, ₹${selectedService.fee})\n\n📅 *Choose a date:*\n\n1️⃣ Today (${today})\n2️⃣ Tomorrow (${tomorrow})\n3️⃣ Day after (${dayAfter})\n\nOr type a date: DD-MM-YYYY`;
  }

  // ── Step 2: Date selection ────────────────────────────────────
  if (step === 'booking_date') {
    const tz = cfg.timezone || 'Asia/Kolkata';
    let date = null;

    if (text === '1') date = moment().tz(tz).format('YYYY-MM-DD');
    else if (text === '2') date = moment().tz(tz).add(1, 'day').format('YYYY-MM-DD');
    else if (text === '3') date = moment().tz(tz).add(2, 'day').format('YYYY-MM-DD');
    else {
      const parsed = moment(text, ['DD-MM-YYYY', 'D-M-YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'], true);
      if (parsed.isValid() && parsed.isSameOrAfter(moment().tz(tz), 'day')) {
        date = parsed.format('YYYY-MM-DD');
      }
    }

    if (!date) {
      return lang === 'hinglish'
        ? `❌ Valid date enter karein.\n1️⃣ Aaj\n2️⃣ Kal\n3️⃣ Parso\nYa DD-MM-YYYY format mein type karein.`
        : `❌ Please enter a valid date.\n1️⃣ Today\n2️⃣ Tomorrow\n3️⃣ Day after\nOr type in DD-MM-YYYY format.`;
    }

    const slots = db.getAvailableSlots(clientId, date);
    if (slots.length === 0) {
      return lang === 'hinglish'
        ? `😔 ${date} ko koi slot available nahi hai. Koi aur date try karein?\n1️⃣ Aaj\n2️⃣ Kal\n3️⃣ Parso\nYa DD-MM-YYYY type karein:`
        : `😔 No slots available on ${date}. Please try another date?\n1️⃣ Today\n2️⃣ Tomorrow\n3️⃣ Day after\nOr type DD-MM-YYYY:`;
    }

    conv.data.date = date;
    conv.step = 'booking_time';
    db.setConversation(clientId, userPhone, conv);

    const slotLines = slots.map((s, i) => `${i + 1}️⃣ ${s}`).join('\n');
    return lang === 'hinglish'
      ? `📅 *${date}* ke available slots:\n\n${slotLines}\n\nNumber type karein apna slot choose karne ke liye:`
      : `📅 Available slots on *${date}*:\n\n${slotLines}\n\nType the number to choose your slot:`;
  }

  // ── Step 3: Time slot selection ───────────────────────────────
  if (step === 'booking_time') {
    const slots = db.getAvailableSlots(clientId, conv.data.date);
    let selectedSlot = null;

    const numMatch = text.match(/^(\d+)$/);
    if (numMatch) {
      const idx = parseInt(numMatch[1]) - 1;
      selectedSlot = slots[idx] || null;
    } else if (/^\d{1,2}:\d{2}$/.test(text) && slots.includes(text)) {
      selectedSlot = text;
    }

    if (!selectedSlot) {
      return lang === 'hinglish'
        ? `❌ Valid slot number choose karein (1-${slots.length}).`
        : `❌ Please choose a valid slot number (1-${slots.length}).`;
    }

    conv.data.time = selectedSlot;
    conv.step = cfg.collectName ? 'booking_name' : (cfg.collectNotes ? 'booking_notes' : 'booking_confirm');
    db.setConversation(clientId, userPhone, conv);

    if (cfg.collectName) {
      return lang === 'hinglish'
        ? `⏰ Slot reserved: *${conv.data.date}* at *${selectedSlot}*\n\n👤 Apna *poora naam* type karein:`
        : `⏰ Slot reserved: *${conv.data.date}* at *${selectedSlot}*\n\n👤 Please type your *full name*:`;
    }

    return buildConfirmMessage(conv.data, cfg, lang);
  }

  // ── Step 4: Name collection ───────────────────────────────────
  if (step === 'booking_name') {
    if (text.trim().length < 2) {
      return lang === 'hinglish' ? `❌ Valid naam enter karein.` : `❌ Please enter a valid name.`;
    }

    conv.data.name = text.trim();
    conv.step = cfg.collectNotes ? 'booking_notes' : 'booking_confirm';
    db.setConversation(clientId, userPhone, conv);

    if (cfg.collectNotes) {
      return lang === 'hinglish'
        ? `👍 Hi *${conv.data.name}*!\n\n📝 Koi special notes/symptoms hai? (Skip karne ke liye "no" type karein)`
        : `👍 Hi *${conv.data.name}*!\n\n📝 Any notes/symptoms to share? (Type "no" to skip)`;
    }

    return buildConfirmMessage(conv.data, cfg, lang);
  }

  // ── Step 5: Notes (optional) ──────────────────────────────────
  if (step === 'booking_notes') {
    conv.data.notes = /^(no|nahi|skip|na|none)$/i.test(text.trim()) ? '' : text.trim();
    conv.step = 'booking_confirm';
    db.setConversation(clientId, userPhone, conv);
    return buildConfirmMessage(conv.data, cfg, lang);
  }

  // ── Step 6: Final confirmation ────────────────────────────────
  if (step === 'booking_confirm') {
    if (intent === 'yes' || /^(confirm|book|yes|ha|haan|1|ok|done)$/i.test(text.trim())) {
      const appt = db.createAppointment(clientId, {
        userPhone,
        userName: conv.data.name || userName,
        serviceId: conv.data.service.id,
        date: conv.data.date,
        time: conv.data.time,
        notes: conv.data.notes || ''
      });

      conv.step = null;
      conv.data = {};
      db.setConversation(clientId, userPhone, conv);

      const confirmMsg = lang === 'hinglish'
        ? `✅ *Booking Confirmed!* 🎉\n\n📋 *Booking ID:* #${appt.id.slice(0, 8).toUpperCase()}\n🏥 *Service:* ${appt.serviceName}\n📅 *Date:* ${appt.date}\n⏰ *Time:* ${appt.time}\n${appt.fee > 0 ? `💰 *Fee:* ₹${appt.fee}\n` : ''}👤 *Name:* ${appt.userName}\n\n${cfg.reminderEnabled ? '⏰ Appointment se pehle reminder bhejenge!\n\n' : ''}Koi aur help chahiye? 😊`
        : `✅ *Booking Confirmed!* 🎉\n\n📋 *Booking ID:* #${appt.id.slice(0, 8).toUpperCase()}\n🏥 *Service:* ${appt.serviceName}\n📅 *Date:* ${appt.date}\n⏰ *Time:* ${appt.time}\n${appt.fee > 0 ? `💰 *Fee:* ₹${appt.fee}\n` : ''}👤 *Name:* ${appt.userName}\n\n${cfg.reminderEnabled ? "⏰ We'll remind you before your appointment!\n\n" : ''}Anything else I can help with? 😊`;

      return confirmMsg;
    } else if (intent === 'no' || /^(no|nahi|cancel|change)$/i.test(text.trim())) {
      conv.step = null;
      conv.data = {};
      db.setConversation(clientId, userPhone, conv);
      return lang === 'hinglish'
        ? `Ok, booking cancel kar diya. Koi aur help chahiye? Main menu ke liye "menu" type karein.`
        : `Okay, booking cancelled. Type "menu" for the main menu, or "book" to start again.`;
    }

    return buildConfirmMessage(conv.data, cfg, lang);
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════
// CANCEL FLOW
// ════════════════════════════════════════════════════════════════════

async function handleCancelFlow(clientId, userPhone, text, intent, conv, cfg, lang) {
  const appts = db.getAllAppointments(clientId, {
    userPhone,
    status: 'confirmed'
  }).filter(a => moment(a.date).isSameOrAfter(moment(), 'day'));

  if (text.match(/^(\d+)$/) && appts.length > 0) {
    const idx = parseInt(text) - 1;
    const appt = appts[idx];

    if (!appt) {
      return lang === 'hinglish'
        ? `❌ Valid number choose karein.`
        : `❌ Please choose a valid number.`;
    }

    db.cancelAppointment(clientId, appt.id);
    conv.step = null;
    db.setConversation(clientId, userPhone, conv);

    return lang === 'hinglish'
      ? `✅ *${appt.serviceName}* — ${appt.date} ${appt.time} ki booking cancel ho gayi.\n\nKoi aur help chahiye?`
      : `✅ Your *${appt.serviceName}* appointment on ${appt.date} at ${appt.time} has been cancelled.\n\nAnything else I can help with?`;
  }

  if (intent === 'no' || /^(back|menu|no)$/i.test(text)) {
    conv.step = null;
    db.setConversation(clientId, userPhone, conv);
    return lang === 'hinglish' ? `Ok! Koi aur help chahiye?` : `Okay! How else can I help?`;
  }

  return await buildCancelMenu(clientId, userPhone, cfg, lang);
}

// ════════════════════════════════════════════════════════════════════
// MESSAGE BUILDERS
// ════════════════════════════════════════════════════════════════════

function buildWelcomeMessage(cfg, lang) {
  return cfg.welcomeMessage + '\n\n' + buildMainMenu(cfg, lang);
}

function buildMainMenu(cfg, lang) {
  return lang === 'hinglish'
    ? `📋 *Main Menu:*\n\n1️⃣ Appointment book karo\n2️⃣ Meri bookings dekho\n3️⃣ Services & prices\n4️⃣ Timings\n\nKoi bhi option type karein ya number bhejein! 😊`
    : `📋 *Main Menu:*\n\n1️⃣ Book an appointment\n2️⃣ My bookings\n3️⃣ Services & prices\n4️⃣ Working hours\n\nType any option or send the number! 😊`;
}

function buildServiceMenu(cfg, lang) {
  const services = cfg.services;
  const lines = services.map((s, i) =>
    `${i + 1}️⃣ *${s.name}* — ${s.duration}min${s.fee > 0 ? ` | ₹${s.fee}` : ' | Free'}`
  ).join('\n');

  return lang === 'hinglish'
    ? `🗂️ *Kaunsi service chahiye?*\n\n${lines}\n\nNumber type karein:`
    : `🗂️ *Which service would you like?*\n\n${lines}\n\nType the number:`;
}

function buildServicesInfo(cfg, lang) {
  const services = cfg.services;
  const lines = services.map(s =>
    `• *${s.name}*\n  ⏱ ${s.duration} min | 💰 ${s.fee > 0 ? '₹' + s.fee : 'Free'}`
  ).join('\n\n');

  return lang === 'hinglish'
    ? `📋 *Humaari Services:*\n\n${lines}\n\nBook karne ke liye "book" type karein! 📅`
    : `📋 *Our Services:*\n\n${lines}\n\nType "book" to schedule an appointment! 📅`;
}

function buildHoursInfo(cfg, lang) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const hindiDays = ['Ravivar', 'Somvar', 'Mangalvar', 'Budhvar', 'Guruvar', 'Shukravar', 'Shanivar'];
  const openDays = cfg.workingHours.days.map(d => lang === 'hinglish' ? hindiDays[d] : dayNames[d]).join(', ');

  return lang === 'hinglish'
    ? `🕐 *Hamari Timings:*\n\n⏰ ${cfg.workingHours.start} – ${cfg.workingHours.end}\n📅 ${openDays}\n\nAppointment lene ke liye "book" type karein! 📅`
    : `🕐 *Working Hours:*\n\n⏰ ${cfg.workingHours.start} – ${cfg.workingHours.end}\n📅 ${openDays}\n\nType "book" to schedule an appointment! 📅`;
}

function buildConfirmMessage(data, cfg, lang) {
  return lang === 'hinglish'
    ? `📋 *Booking Details confirm karein:*\n\n🏥 *Service:* ${data.service.name}\n📅 *Date:* ${data.date}\n⏰ *Time:* ${data.time}\n${data.name ? `👤 *Naam:* ${data.name}\n` : ''}${data.notes ? `📝 *Notes:* ${data.notes}\n` : ''}${data.service.fee > 0 ? `💰 *Fee:* ₹${data.service.fee}\n` : ''}\n*Confirm karna hai?* "yes" ya "no" type karein`
    : `📋 *Confirm your booking:*\n\n🏥 *Service:* ${data.service.name}\n📅 *Date:* ${data.date}\n⏰ *Time:* ${data.time}\n${data.name ? `👤 *Name:* ${data.name}\n` : ''}${data.notes ? `📝 *Notes:* ${data.notes}\n` : ''}${data.service.fee > 0 ? `💰 *Fee:* ₹${data.service.fee}\n` : ''}\n*Confirm?* Type "yes" or "no"`;
}

async function buildCancelMenu(clientId, userPhone, cfg, lang) {
  const appts = db.getAllAppointments(clientId, { userPhone, status: 'confirmed' })
    .filter(a => moment(a.date).isSameOrAfter(moment(), 'day'));

  if (appts.length === 0) {
    return lang === 'hinglish'
      ? `😊 Aapki koi upcoming booking nahi hai.\n\nNew booking ke liye "book" type karein!`
      : `😊 You have no upcoming bookings.\n\nType "book" to make a new appointment!`;
  }

  const lines = appts.map((a, i) =>
    `${i + 1}️⃣ *${a.serviceName}* — ${a.date} at ${a.time}`
  ).join('\n');

  return lang === 'hinglish'
    ? `📋 *Upcoming Bookings:*\n\n${lines}\n\nKaun si cancel karni hai? Number type karein.\n(Wapas jaane ke liye "back" type karein)`
    : `📋 *Your Upcoming Appointments:*\n\n${lines}\n\nWhich one to cancel? Type the number.\n(Type "back" to go back)`;
}

async function buildAppointmentStatus(clientId, userPhone, cfg, lang) {
  const appts = db.getAllAppointments(clientId, { userPhone })
    .filter(a => moment(a.date).isSameOrAfter(moment(), 'day') && a.status === 'confirmed')
    .slice(0, 3);

  if (appts.length === 0) {
    return lang === 'hinglish'
      ? `😊 Aapki koi upcoming booking nahi hai.\n\nNew booking ke liye "book" type karein!`
      : `😊 No upcoming appointments found.\n\nType "book" to schedule one!`;
  }

  const lines = appts.map(a =>
    `📋 *${a.serviceName}*\n📅 ${a.date} ⏰ ${a.time}\n🆔 #${a.id.slice(0, 8).toUpperCase()}`
  ).join('\n\n');

  return lang === 'hinglish'
    ? `📅 *Aapki Upcoming Appointments:*\n\n${lines}\n\nCancel karne ke liye "cancel" type karein.`
    : `📅 *Your Upcoming Appointments:*\n\n${lines}\n\nType "cancel" to cancel an appointment.`;
}

module.exports = { handleMessage };
