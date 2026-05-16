# 🤖 WhatsApp Appointment Agent — SaaS System

A complete multi-client WhatsApp appointment booking bot you can sell to businesses for ₹1000/month.

---

## 🏗️ Architecture

```
Admin (You) ──── /admin/dashboard ──── manages all 10 clients
                                        └── create/renew/suspend clients
                                        └── show QR codes
                                        └── live message monitor

Client (Business) ── /dashboard ──── their own panel
                                      └── view appointments
                                      └── configure services/hours
                                      └── connect WhatsApp

WhatsApp Users ── WA messages ──── AI Agent handles them
                                    └── Book appointments
                                    └── Cancel bookings
                                    └── FAQ answers
```

---

## 📁 Project Structure

```
whatsapp-agent/
├── src/
│   ├── server.js                # Entry point
│   ├── agent/
│   │   └── appointmentAgent.js  # Core booking AI logic
│   ├── db/
│   │   └── database.js          # JSON database (no external DB needed)
│   ├── middleware/
│   │   └── auth.js
│   ├── routes/
│   │   ├── admin.js             # Your seller panel
│   │   └── dashboard.js         # Client's panel
│   └── services/
│       ├── aiService.js         # Gemini + Cohere fallback
│       ├── scheduler.js         # Reminders + expiry cron
│       └── whatsappManager.js   # WA sessions manager
├── data/                        # Auto-created, gitignored
│   ├── master.json              # All clients + licenses
│   ├── clients/{id}/data.json   # Per-client appointments
│   └── sessions/{id}/           # WA auth sessions
├── render.yaml                  # One-click Render deploy
└── .env.example
```

---

## 🚀 Deployment on Render (Free 24/7)

### Step 1: Get Free API Keys

**Gemini (primary):**
1. Go to https://aistudio.google.com/app/apikey
2. Create API key — free 60 requests/minute

**Cohere (fallback):**
1. Go to https://dashboard.cohere.com/api-keys
2. Free tier: 1000 calls/month per key

### Step 2: Deploy to Render

1. Push this code to a GitHub repo
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Render auto-detects `render.yaml`
5. Set environment variables in Render dashboard:
   ```
   GEMINI_API_KEY=your_key
   COHERE_API_KEY=your_key
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=yourStrongPassword123
   ```
6. Add a **Disk** (1GB, free): mount path `/app/data`
7. Deploy!

### Step 3: Set Keep-Alive URL

After deploy, copy your Render URL (e.g. `https://wa-agent.onrender.com`).
Add env var:
```
KEEP_ALIVE_URL=https://wa-agent.onrender.com/ping
```

This pings itself every 14 min to prevent Render free tier sleep.

---

## 💼 How to Onboard a New Client (₹1000/month)

### You do (takes 5 minutes):

1. **Go to:** `https://your-app.onrender.com/admin/dashboard`
2. **Click:** "Add Client"
3. **Fill in:** Business name, type, WhatsApp number, months paid
4. **Click:** "Create & Start Bot" → QR code appears
5. **Share QR** with the client over video call or screenshot

### Client does:
1. Opens WhatsApp → Linked Devices → Link a Device
2. Scans your QR
3. Bot is live! ✅

### Give the client:
- Their dashboard URL: `https://your-app.onrender.com/dashboard/login`
- Their access key (the `apiKey` field you set — use UUID)

---

## 🔑 License / Expiry System

The expiry is **automatic**:
- `status: active` + `expiryDate` in the future = bot works
- When `expiryDate` passes: bot auto-replies "service unavailable"
- Dashboard login blocked when expired
- You control expiry only from admin panel

**To renew a client:**
Admin panel → find client → click "Renew" → enter months + amount received → done.

---

## 🤖 What the Bot Does

### For every incoming message:
1. Checks if client is active (not expired)
2. Checks working hours
3. Detects language (English/Hinglish/Hindi)
4. Classifies intent (book/cancel/FAQ/greet...)
5. Handles multi-turn booking flow or answers directly

### Booking flow:
```
User: "book"
Bot: Shows services list

User: "1"
Bot: Shows available dates

User: "tomorrow"
Bot: Shows time slots

User: "3"
Bot: Asks name

User: "Rahul"
Bot: Shows confirmation

User: "yes"
Bot: ✅ Confirmed! Booking ID #A1B2C3D4
```

### Auto-reminders:
Bot sends WhatsApp message 2 hours before appointment automatically.

---

## 🏢 Supported Business Types

Each type comes with preset services, working hours, and FAQ:

| Type | Preset Services | Default Hours |
|------|----------------|---------------|
| Clinic | General Consultation, Follow-up, Report Discussion | 9am–6pm, Mon–Sat |
| Salon | Haircut, Facial, Hair Color, Manicure | 9am–7pm, Mon–Sat |
| Tutor | Demo Class, 1-on-1 Session, Doubt Session | 7am–9pm, All days |
| Restaurant | Table for 2/4, Private Dining | 11am–11pm |
| Gym | Trial, Personal Training, Diet Consult | 6am–10pm, All days |
| Generic | Consultation, Service Appointment | 9am–6pm, Mon–Sat |

All presets are fully editable from the client's dashboard.

---

## 💰 Scaling to 10 Clients

Each client runs in a separate:
- WhatsApp session (separate Puppeteer instance)
- Data store (`data/clients/{id}/data.json`)
- Bot configuration

**Memory estimate on Render free (512MB):**
- Each WA session uses ~40–80MB
- 6–7 simultaneous sessions is safe on free tier
- For 10 clients: upgrade to Render Starter ($7/mo) = 1GB RAM

**Revenue:** 10 clients × ₹1000 = ₹10,000/month
**Cost:** ₹570/mo (Render Starter) = **₹9,430 profit**

---

## ⚠️ Important Notes

1. **WhatsApp ToS:** whatsapp-web.js is unofficial. Don't use it for spam. Appointment bots with user consent are generally fine.
2. **Session persistence:** Render free tier has ephemeral storage without a disk add-on. Always attach the 1GB disk.
3. **QR re-scan:** Sessions persist across restarts. Client only needs to scan once unless they log out WhatsApp.
4. **API limits:** Gemini free = 60 RPM, Cohere free = 1000/month. More than enough for 10 small businesses.

---

## 🛠️ Local Development

```bash
cp .env.example .env
# Fill in your API keys

npm install
node src/server.js

# Admin: http://localhost:3000/admin/dashboard (admin / changeme123)
# Client: http://localhost:3000/dashboard/login
```
