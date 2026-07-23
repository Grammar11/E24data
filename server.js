// E24 Data — Backend Server
// Customer → Server → API → MTN/Airtel/Glo/9mobile → Data lands
//
// Clubkonnect UserID/APIKey live only as environment variables here.
// Wallet + cards now live in MongoDB Atlas instead of a local db.json file,
// because Render's free tier wipes local files on every restart.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const PDFDocument = require('pdfkit');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CK_USERID = process.env.CLUBKONNECT_USERID;
const CK_APIKEY = process.env.CLUBKONNECT_APIKEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '@Nura2652';
const MONGODB_URI = process.env.MONGODB_URI;

if (!CK_USERID || !CK_APIKEY) {
  console.warn('⚠️  CLUBKONNECT_USERID / CLUBKONNECT_APIKEY not set.');
}
if (!MONGODB_URI) {
  console.warn('⚠️  MONGODB_URI not set. Database calls will fail.');
}

const NETWORK_CODES = {
  MTN: '01',
  Glo: '02',
  '9mobile': '03',
  Airtel: '04',
};

const DATA_PLAN_CODES = {
  'MTN_500MB': '9', 'MTN_1GB': '10', 'MTN_2GB': '11', 'MTN_5GB': '13',
  'Glo_500MB': '2', 'Glo_1GB': '3', 'Glo_2GB': '4', 'Glo_5GB': '6',
  '9mobile_500MB': '4', '9mobile_1GB': '5', '9mobile_2GB': '6', '9mobile_5GB': '9',
  'Airtel_500MB': '19', 'Airtel_1GB': '20', 'Airtel_2GB': '26', 'Airtel_5GB': '29',
};

const client = new MongoClient(MONGODB_URI);
let stateCollection;

async function connectDB() {
  await client.connect();
  const database = client.db('e24data');
  stateCollection = database.collection('state');
  const existing = await stateCollection.findOne({ _id: 'main' });
  if (!existing) {
    await stateCollection.insertOne({ _id: 'main', wallet: 0, cards: [] });
    console.log('Created initial database document.');
  }
  console.log('✅ Connected to MongoDB Atlas.');
}

async function loadDB() {
  return stateCollection.findOne({ _id: 'main' });
}
async function saveDB(db) {
  await stateCollection.replaceOne({ _id: 'main' }, db);
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

app.get('/api/wallet', requireAdmin, async (req, res) => {
  const db = await loadDB();
  res.json({ wallet: db.wallet });
});

app.post('/api/wallet/topup', requireAdmin, async (req, res) => {
  const amount = parseInt(req.body.amount, 10);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const db = await loadDB();
  db.wallet += amount;
  await saveDB(db);
  res.json({ wallet: db.wallet });
});

app.get('/api/cards', requireAdmin, async (req, res) => {
  const db = await loadDB();
  res.json({ cards: db.cards });
});

app.post('/api/cards/generate', requireAdmin, async (req, res) => {
  const { network, size, price, qty } = req.body;
  const q = Math.min(Math.max(parseInt(qty, 10) || 1, 1), 5000);
  const p = parseInt(price, 10) || 0;
  const totalCost = p * q;

  const db = await loadDB();
  if (totalCost > db.wallet) {
    return res.status(400).json({ error: 'Insufficient wallet balance' });
  }

  const newCards = [];
  for (let i = 0; i < q; i++) {
    newCards.push({ pin: genPin(), network, size, price: p, status: 'unused' });
  }
  db.cards.push(...newCards);
  db.wallet -= totalCost;
  await saveDB(db);

  res.json({ cards: newCards, wallet: db.wallet });
});

app.post('/api/redeem', async (req, res) => {
  const { pin, phone } = req.body;

  if (!pin || !phone) {
    return res.status(400).json({ error: 'PIN and phone number are required' });
  }

  const db = await loadDB();
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
      error: 'This network/data size is not configured yet. Update DATA_PLAN_CODES in server.js.',
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

    if (result && (result.status === 'ORDER_COMPLETED' || result.status === 'ORDER_RECEIVED')) {
      card.status = 'used';
      card.redeemedTo = phone;
      card.redeemedAt = new Date().toISOString();
      card.orderId = result.orderid || null;
      await saveDB(db);
      return res.json({ success: true, message: `${card.size} sent to ${phone}`, raw: result });
    }

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

app.get('/api/debug-balance', async (req, res) => {
  try {
    const response = await axios.get('https://www.nellobytesystems.com/APIWalletBalanceV1.asp', {
      params: { UserID: CK_USERID, APIKey: CK_APIKEY },
      timeout: 20000,
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({
