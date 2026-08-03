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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '@Nura2652';
const MONGODB_URI = process.env.MONGODB_URI;


if (!MONGODB_URI) {
  console.warn('⚠️  MONGODB_URI not set. Database calls will fail.');
}
const NETWORK_IDS = {
  MTN: 1,
  Glo: 2,
  '9mobile': 3,
  Airtel: 4,
};

const SMEAPI_PLAN_IDS = {
  MTN_500MB: 1,
  MTN_1GB: 2,
  MTN_2GB: 3,
  MTN_3GB: 4,
  Airtel_1GB: 75,
  Airtel_2GB: 79,
  Airtel_3GB: 84,
  Glo_1GB: 113,
  'Glo_2.5GB': 121,
  Glo_3GB: 123
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
    return String(Math.floor(10000000 + Math.random() * 90000000));
  }

  function genUniquePin(existingPins) {
    let pin;
    do {
      pin = genPin();
    } while (existingPins.has(pin));
    existingPins.add(pin);
    return pin;
  }

  function genUniqueSerial(db) {
    db.serialCounter = (db.serialCounter || 0) + 1;
    return String(db.serialCounter).padStart(8, '0');
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

  const existingPins = new Set(db.cards.map(c => c.pin));
    const newCards = [];
    for (let i = 0; i < q; i++) {
      const pin = genUniquePin(existingPins);
      const serial = genUniqueSerial(db);
      newCards.push({ pin, serial, network, size, price: p, status: 'unused' });
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

  const networkId = NETWORK_IDS[card.network];
  const planId = SMEAPI_PLAN_IDS[`${card.network}_${card.size}`];

  if (!networkId || !planId) {
    return res.status(500).json({
      error: 'This network/data size is not configured yet. Update SMEAPI_PLAN_IDS.'
    });
  }

  const ref = `E24-${Date.now()}`;

  try {
    const response = await axios.post(
      'https://smeapi.com.ng/api/data/',
      {
        network: networkId,
        data_plan: planId,
        phone: phone,
        ported_number: false,
        ref: ref
      },
      {
        headers: {
  'Authorization': `Token ${process.env.SMEAPI_KEY?.trim()}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json'
        }
      }
    );

    const result = response.data;

    if (result && result.status === 'success') {
      card.status = 'used';
      card.redeemedTo = phone;
      card.redeemedAt = new Date().toISOString();
      card.orderRef = ref;
      await saveDB(db);
      return res.json({ success: true, message: `${card.size} sent to ${phone}` });
    }

    console.log('SME API rejected order. Raw response:', JSON.stringify(result));
    return res.status(502).json({
      success: false,
      error: 'SME API could not complete the order',
      raw: result
    });

} catch (err) {
    console.error('SME API error - Full details:');
    console.error('Status code:', err.response?.status);
    console.error('Response headers:', JSON.stringify(err.response?.headers));
    console.error('Response body:', JSON.stringify(err.response?.data));
    console.error('Request headers sent:', JSON.stringify(err.config?.headers));
    console.error('Error message:', err.message);
    return res.status(502).json({ success: false, error: 'Could not reach SME API' });
  }
});

app.post('/api/ussd', async (req, res) => {
  const { phoneNumber, text } = req.body;
  res.set('Content-Type', 'text/plain');

  const parts = (text || '').split('*').filter(Boolean);

  try {
    if (parts.length === 0) {
      return res.send('CON Welcome to E24Data\nEnter your PIN to redeem data:');
    }

 const pin = parts[0].replace(/-/g, '');
      const phone = phoneNumber;

    const db = await loadDB();
    const card = db.cards.find(c => c.pin.replace(/-/g, '') === pin);

    if (!card) {
      return res.send('END PIN not found. Please check and try again.');
    }
    if (card.status === 'used') {
      return res.send('END This PIN has already been used.');
    }

    const networkId = NETWORK_IDS[card.network];
    const planId = SMEAPI_PLAN_IDS[`${card.network}_${card.size}`];

    if (!networkId || !planId) {
      return res.send('END This network/data size is not available yet.');
    }

    const ref = `E24-${Date.now()}`;

    const response = await axios.post(
      'https://smeapi.com.ng/api/data/',
      {
        network: networkId,
        data_plan: planId,
        phone: phone,
        ported_number: false,
        ref: ref
      },
      {
        headers: {
          'Authorization': `Token ${process.env.SMEAPI_KEY?.trim()}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    const result = response.data;

    if (result && result.status === 'success') {
      card.status = 'used';
      card.redeemedTo = phone;
      card.redeemedAt = new Date().toISOString();
      card.orderRef = ref;
      await saveDB(db);
      return res.send(`END Success! ${card.size} has been sent to ${phone}`);
    }

    return res.send('END Sorry, the network could not complete this order. Please try again later.');

  } catch (err) {
     console.error('USSD redeem error - Status:', err.response?.status);
     console.error('USSD redeem error - Body:', JSON.stringify(err.response?.data));
     console.error('USSD redeem error - Message:', err.message);
     return res.send('END Sorry, something went wrong. Please try again later.');
  }
});
app.post('/api/cards/pdf', (req, res) => {
 try {
  if (req.body.adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).send('Unauthorized');
  }
  let cards;
  try {
    cards = JSON.parse(req.body.cards);
  } catch (e) {
    return res.status(400).send('Invalid cards data');
  }
  if (!Array.isArray(cards) || cards.length === 0) {
    return res.status(400).send('No cards provided');
  }
  console.log(`📄 PDF request: ${cards.length} cards`);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="e24data-cards.pdf"');

  const doc = new PDFDocument({ size: 'A4', margin: 20 });
  doc.pipe(res);

  const gap = 6;
  const cols = 5;
  const rows = 10;
  const perPage = cols * rows;
  const margin = 20;
  const cardW = (doc.page.width - margin * 2 - gap * (cols - 1)) / cols;
  const cardH = (doc.page.height - margin * 2 - gap * (rows - 1)) / rows;

  cards.forEach((card, i) => {
    const posInPage = i % perPage;
    if (i > 0 && posInPage === 0) doc.addPage();

    const col = posInPage % cols;
    const row = Math.floor(posInPage / cols);
    const x = margin + col * (cardW + gap);
    const y = margin + row * (cardH + gap);

    doc.rect(x, y, cardW, cardH).stroke();

    doc.rect(x + 5, y + 5, 7, 7).fill('black');
    doc.fillColor('black');
    doc.fontSize(7).font('Helvetica-Bold')
      .text('E24MARKET', x + 15, y + 5, { width: cardW / 2, align: 'left' });
    doc.fontSize(7).font('Helvetica-Bold')
      .text(`${card.network} ${card.size}`, x, y + 5, { width: cardW - 5, align: 'right' });

    doc.fontSize(5).font('Helvetica')
      .text(`S/N: ${card.serial || String(i + 1).padStart(8, '0')}`, x, y + 18, { width: cardW, align: 'center' });
    doc.fontSize(13).font('Courier-Bold')
      .text(`PIN: ${card.pin}`, x, y + cardH / 2 - 7, { width: cardW, align: 'center' });

    doc.fontSize(6).font('Helvetica')
      .text('Dial *XXXX# to redeem', x, y + cardH - 22, { width: cardW, align: 'center' });

    doc.fontSize(5).font('Helvetica')
      .text('Customer Care: 08147972378', x, y + cardH - 12, { width: cardW, align: 'center' });
  });

  doc.end();
  console.log('✅ PDF generation complete');
 } catch (err) {
  console.error('❌ PDF generation error:', err.message);
  console.error(err.stack);
  if (!res.headersSent) res.status(500).send('PDF generation failed: ' + err.message);
 }
});
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`E24 Data backend running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });
