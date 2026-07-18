# E24 Data Backend

This server is the missing "Server" step between your customers and Clubkonnect:

```
Customer → E24 Data website → THIS SERVER → Clubkonnect API → MTN/Airtel/Glo/9mobile → Data lands
```

Your Clubkonnect UserID and APIKey live here, as environment variables — never
in the website itself, where anyone could steal them by viewing page source.

## 1. Get your real data plan codes

Log in to your Clubkonnect account, go to **API Documentation**, and find the
**Data Bundle API** page and **Data Bundle Prices** page. Open `server.js` and
replace every `REPLACE_ME` in `DATA_PLAN_CODES` with the exact codes shown
there for MTN, Airtel, Glo and 9mobile. Also double check the `NETWORK_CODES`
numbers match what your account's docs show — these can differ by account.

## 2. Install and configure

```bash
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `CLUBKONNECT_USERID` — your Clubkonnect username
- `CLUBKONNECT_APIKEY` — your Clubkonnect API key
- `ADMIN_PASSWORD` — password for the admin dashboard (already set to your chosen password)

## 3. Whitelist your server's IP

Clubkonnect requires you to whitelist the IP address of the server that will
call their API (see "IP white listing" in their API docs). You'll only get
this IP address once you deploy the server (step 4) — go back and whitelist
it in your Clubkonnect account afterward.

## 4. Run it

Locally, for testing:
```bash
npm start
```

For real use, deploy this folder to a service that keeps a server running,
such as Render, Railway, or a VPS (DigitalOcean, etc.) — NOT a static site
host, since this needs to run continuously and keep your API key secret.
Set the same environment variables (`CLUBKONNECT_USERID`, `CLUBKONNECT_APIKEY`,
`ADMIN_PASSWORD`) in that host's dashboard.

## 5. Connect the website to this server

Once deployed, you'll have a URL like `https://e24data-backend.onrender.com`.
Open the E24 Data website file and set `API_BASE_URL` (near the top of the
`<script>` section) to that URL. Until you do this, the website's Redeem PIN
and Admin Dashboard won't be able to reach this server.

## Important notes

- The `data/db.json` file is a simple stand-in database for testing. For a
  real launch, replace it with a proper database (PostgreSQL, MySQL, etc.) —
  a JSON file can get corrupted if two requests write to it at the same time.
- `POST /api/wallet/topup` currently trusts whatever amount is sent to it.
  Before accepting real money, connect it to a payment gateway (Paystack or
  Flutterwave) so the wallet is only credited after a confirmed payment.
- Admin authentication is a single shared password for now. Before giving
  dashboard access to other agents, add proper per-agent accounts.
