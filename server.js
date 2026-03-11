const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

// Load .env if present (Railway provides env vars directly)
const envPath = path.join(__dirname, '.env');
if (require('fs').existsSync(envPath)) {
  require('fs')
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .forEach((line) => {
      const [key, ...rest] = line.split('=');
      process.env[key.trim()] = rest.join('=').trim();
    });
}

const app = express();
app.use(express.json());
// Dynamic manifest — embeds access key in start_url for PWA Home Screen launch
app.get('/manifest.json', (req, res) => {
  const key = req.query.key || '';
  res.json({
    name: 'DozoTime!',
    short_name: 'DozoTime!',
    start_url: key ? `/?key=${encodeURIComponent(key)}` : '/',
    display: 'standalone',
    background_color: '#3B0A2A',
    theme_color: '#3B0A2A',
  });
});

app.use(express.static(path.join(__dirname, 'public')));

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Access key guard
const ACCESS_KEY = process.env.ACCESS_KEY;
app.use('/api', (req, res, next) => {
  if (ACCESS_KEY && req.headers['x-access-key'] !== ACCESS_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
});

// Persistent subscription store
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

function loadSubscriptions() {
  try {
    const data = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveSubscriptions() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SUBS_FILE, JSON.stringify(Object.fromEntries(subscriptions)));
}

const subscriptions = loadSubscriptions();
console.log(`Loaded ${subscriptions.size} subscription(s) from disk`);

// Expose public key to frontend
app.get('/api/vapid-public-key', (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Subscribe
app.post('/api/subscribe', (req, res) => {
  const { name, ...sub } = req.body;
  subscriptions.set(sub.endpoint, { ...sub, name: name || 'Unknown' });
  saveSubscriptions();
  console.log(`+ subscriber "${name}" (${subscriptions.size} total)`);
  res.status(201).json({ ok: true });
});

// Unsubscribe
app.post('/api/unsubscribe', (req, res) => {
  subscriptions.delete(req.body.endpoint);
  saveSubscriptions();
  console.log(`- subscriber (${subscriptions.size} total)`);
  res.json({ ok: true });
});

// Send "DozoTime!" to everyone
app.post('/api/yo', async (req, res) => {
  const { location, name } = req.body;
  if (!location || !location.trim()) {
    return res.status(400).json({ error: 'location required' });
  }

  const sender = name || 'Someone';
  const payload = JSON.stringify({
    title: 'DozoTime!',
    body: `${sender} is at ${location.trim()}!`,
    timestamp: Date.now(),
  });

  const results = await Promise.allSettled(
    [...subscriptions.values()].map((sub) =>
      webpush.sendNotification(sub, payload).catch((err) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          subscriptions.delete(sub.endpoint);
          saveSubscriptions();
        }
        throw err;
      })
    )
  );

  const sent = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - sent;
  console.log(`DozoTime! "${location.trim()}" → ${sent} delivered, ${failed} failed`);
  res.json({ sent, failed });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DozoTime! server → http://localhost:${PORT}`));
