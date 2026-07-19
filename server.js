// E24 Data — Backend Server
// This is the "Server" step in: Customer → Server → API → MTN/Airtel/Glo/9mobile → Data lands
//
// WHY THIS FILE EXISTS:
// Your Clubkonnect UserID and APIKey must NEVER live in the website's HTML/JS,
// because anyone can view page source and steal them. This server keeps those
// secrets safe (as environment variables) and is the ONLY thing that talks to
// Clubkonnect. The website talks to THIS server instead.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CK_USERID = process.env.CLUBKONNECT_USERID;
const CK_APIKEY = process.env.CLUBKONNECT_APIKEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '@Nura2652';

if (!CK_USERID || !CK_APIKEY) {
  console.warn('⚠️  CLUBKONNECT_USERID / CLUBKONNECT_APIKEY not set. Copy .env.example to .env and fill them in.');
}

// ---------------------------------------------------------------------------
// Clubkonnect network + data plan codes.
//
// IMPORTANT: These MobileNetwork numbers and DataPlan codes are specific to
// YOUR Clubkonnect account and can change. Log in to clubkonnect.com, open
// "API Documentation" and the "Data Bundle Prices" page, and replace the
// values below with the exact codes shown there. Do not guess — using the
// wrong DataPlan code will sell the wrong bundle or fail the order.
// ---------------------------------------------------------------------------
const NETWORK_CODES = {
  MTN: '01',
  Glo: '02',
  '9mobile': '03',
  Airtel: '04',
};

// Map "<Network>_<Size>" -> Clubkonnect DataPlan code (PRODUCT_CODE from
// their API docs, fetched from https://www.nellobytesystems.com/APIDatabundlePlansV3.asp)
// Confirmed against account CK101284802 on 2026-07-19.
const DATA_PLAN_CODES = {
  // MTN — Monthly SME plans
  'MTN_500MB': '9',   // 500 MB - Monthly (SME), ₦307
  'MTN_1GB': '10',    // 1 GB - Monthly (SME), ₦563
  'MTN_2GB': '11',    // 2 GB - Monthly (SME), ₦1117
  'MTN_5GB': '13',    // 5 GB - Monthly (SME), ₦2511

  // Glo
  'Glo_500MB': '2',   // 500 MB - 7 days (SME), ₦230
  'Glo_1GB': '3',     // 1 GB - 30 days (SME), ₦461
  'Glo_2GB': '4',     // 2 GB - 30 days (SME), ₦922
  'Glo_5GB': '6',     // 5 GB - 30 days (SME), ₦2306

  // 9mobile (Clubkonnect calls this "t2mobile" / "m_9mobile")
  '9mobile_500MB': '4',  // 500 MB - 30 days (SME), ₦246
  '9mobile_1GB': '5',    // 1 GB - 30 days (SME), ₦492
  '9mobile_2GB': '6',    // 2 GB - 30 days (SME), ₦984
  '9mobile_5GB': '9',    // 5 GB - 30 days (SME), ₦2460

  // Airtel — no exact 5GB plan exists; using 8GB so customers never get
  // less than advertised. Update the "5GB" label in the frontend dropdown
  // to "8GB" for Airtel if you want this to be fully accurate.
  'Airtel_500MB': '19',  // 500MB - 7 days (Direct Data), ₦484.92
  'Airtel_1GB': '20',    // 1GB - 7 days (Direct Data), ₦775.91
  'Airtel_2GB': '26',    // 2GB - 30 days (Direct Data), ₦1454.93
  'Airtel_5GB': '29',    // 8GB - 30 days (Direct Data), ₦2909.92 — closest to 5GB
};

// ---------------------------------------------------------------------------
// Tiny file-based "database". Fine for testing — for real launch, replace
// this with a proper database (PostgreSQL, MySQL, MongoDB) so multiple
// requests can't corrupt the file and data survives server restarts cleanly.
// ---------------------------------------------------------------------------
const DB_PATH = path.join(__dirname, 'db.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    return { wallet: 0, cards: [] };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function genPin() {
  const seg = () => String(Math.floor(1000 + Math.random() * 9000));
  return `${seg()}-${seg()}-${seg()}`;
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /api/wallet
// ---------------------------------------------------------------------------
app.get('/api/wallet', requireAdmin, (req, res) => {
  const db = loadDB();
  res.json({ wallet: db.wallet });
});

// ---------------------------------------------------------------------------
// POST /api/wallet/topup   { amount }
// Demo only — in production this should be replaced by a real payment
// gateway (Paystack/Flutterwave) webhook that credits the wallet after a
// confirmed payment, never a client-supplied amount.
// ---------------------------------------------------------------------------
app.post('/api/wallet/topup', requireAdmin, (req, res) => {
  const amount = parseInt(req.body.amount, 10);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const db = loadDB();
  db.wallet += amount;
  saveDB(db);
  res.json({ wallet: db.wallet });
});

// ---------------------------------------------------------------------------
// GET /api/cards
// ---------------------------------------------------------------------------
app.get('/api/cards', requireAdmin, (req, res) => {
  const db = loadDB();
  res.json({ cards: db.cards });
});

// ---------------------------------------------------------------------------
// POST /api/cards/generate   { network, size, price, qty }
// ---------------------------------------------------------------------------
app.post('/api/cards/generate', requireAdmin, (req, res) => {
  const { network, size, price, qty } = req.body;
  const q = Math.min(Math.max(parseInt(qty, 10) || 1, 1), 50);
  const p = parseInt(price, 10) || 0;
  const totalCost = p * q;

  const db = loadDB();
  if (totalCost > db.wallet) {
    return res.status(400).json({ error: 'Insufficient wallet balance' });
  }

  const newCards = [];
  for (let i = 0; i < q; i++) {
    newCards.push({ pin: genPin(), network, size, price: p, status: 'unused' });
  }
  db.cards.push(...newCards);
  db.wallet -= totalCost;
  saveDB(db);

  res.json({ cards: newCards, wallet: db.wallet });
});

// ---------------------------------------------------------------------------
// POST /api/redeem   { pin, phone }
// This is the real integration: Customer's PIN → this server → Clubkonnect
// API → network → data lands on `phone`.
// ---------------------------------------------------------------------------
app.post('/api/redeem', async (req, res) => {
  const { pin, phone } = req.body;

  if (!pin || !phone) {
    return res.status(400).json({ error: 'PIN and phone number are required' });
  }

  const db = loadDB();
  const card = db.cards.find((c) => c.pin === pin);

  if (!card) {
    return res.status(404).json({ error: 'PIN not found' });
  }
  if (card.status === 'used') {
    return res.status(409).json({ error: 'This PIN has already been used' });
  }

  const networkCode = NETWORK_CODES[card.network];
  const planCode = DATA_PLAN_CODES[`${card.network}_${card.size}`];

  if (!networkCode || !planCode || planCode === 'REPLACE_ME') {
    return res.status(500).json({
      error: 'This network/data size is not configured yet. Update DATA_PLAN_CODES in server.js with the real codes from your Clubkonnect dashboard.',
    });
  }

  const requestID = `E24-${Date.now()}`;

  try {
    const response = await axios.get('https://www.nellobytesystems.com/APIDatabundleV1.asp', {
      params: {
        UserID: CK_USERID,
        APIKey: CK_APIKEY,
        MobileNetwork: networkCode,
        DataPlan: planCode,
        MobileNumber: phone,
        RequestID: requestID,
      },
      timeout: 20000,
    });

    const result = response.data;

    // Clubkonnect returns a JSON string like {"status":"ORDER_COMPLETED", ...}
    // See: https://www.clubkonnect.com/APIDocs.asp (log in to view full status codes)
    if (result && (result.status === 'ORDER_COMPLETED' || result.status === 'ORDER_RECEIVED')) {
      card.status = 'used';
      card.redeemedTo = phone;
      card.redeemedAt = new Date().toISOString();
      card.orderId = result.orderid || null;
      saveDB(db);
      return res.json({ success: true, message: `${card.size} sent to ${phone}`, raw: result });
    }

    // Card stays unused so the customer/agent can retry.
    console.log('Clubkonnect rejected order. Raw response:', JSON.stringify(result));
    return res.status(502).json({
      success: false,
      error: 'Clubkonnect could not complete the order',
      raw: result,
    });
  } catch (err) {
    console.error('Clubkonnect API error:', err.message);
    return res.status(502).json({ success: false, error: 'Could not reach Clubkonnect. Try again shortly.' });
  }
});

app.listen(PORT, () => {
  console.log(`E24 Data backend running on port ${PORT}`);
});
