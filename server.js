require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3600;
const BEEPER_URL = process.env.BEEPER_URL || 'http://localhost:23373';
const BEEPER_ACCESS_TOKEN = process.env.BEEPER_ACCESS_TOKEN || '';
const RECIPIENTS_FILE = path.join(__dirname, 'recipients.json');

const beeper = axios.create({
  baseURL: BEEPER_URL,
  headers: {
    Authorization: `Bearer ${BEEPER_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function readRecipients() {
  try {
    const data = await fs.readFile(RECIPIENTS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeRecipients(recipients) {
  await fs.writeFile(RECIPIENTS_FILE, JSON.stringify(recipients, null, 2), 'utf8');
}

// GET /api/status
app.get('/api/status', async (req, res) => {
  try {
    let info;
    try {
      const r = await beeper.get('/v1/whoami');
      info = r.data;
    } catch (err) {
      if (err.response && err.response.status === 404) {
        const r2 = await beeper.get('/v1/chats?limit=1');
        info = r2.data;
      } else {
        throw err;
      }
    }
    res.json({ connected: true, info });
  } catch (err) {
    res.json({ connected: false, info: null, error: err.message });
  }
});

// GET /api/chats
app.get('/api/chats', async (req, res) => {
  try {
    const r = await beeper.get('/v1/chats?limit=100');
    const chats = Array.isArray(r.data) ? r.data : (r.data.chats || []);
    const instagram = chats
      .filter(c => c.accountId === 'instagramgo')
      .map(c => ({
        chatId: c.id,
        name: c.name || c.id,
        accountId: c.accountId,
        username: c.name || c.id,
      }));
    res.json(instagram);
  } catch (err) {
    const status = err.response ? err.response.status : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// POST /api/send
app.post('/api/send', async (req, res) => {
  const { chatId, message } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ success: false, error: 'chatId and message are required' });
  }
  try {
    const r = await beeper.post(`/v1/chats/${encodeURIComponent(chatId)}/messages`, { text: message });
    res.json({ success: true, result: r.data });
  } catch (err) {
    const status = err.response ? err.response.status : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// POST /api/broadcast
app.post('/api/broadcast', async (req, res) => {
  const { message, ids, delay: delayMs = 2000 } = req.body;
  if (!message) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }
  try {
    let recipients = await readRecipients();
    if (ids && Array.isArray(ids) && ids.length > 0) {
      recipients = recipients.filter(r => ids.includes(r.id));
    }
    const results = [];
    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      try {
        const r = await beeper.post(`/v1/chats/${encodeURIComponent(recipient.chatId)}/messages`, { text: message });
        results.push({ id: recipient.id, name: recipient.name, chatId: recipient.chatId, success: true, result: r.data });
      } catch (err) {
        results.push({ id: recipient.id, name: recipient.name, chatId: recipient.chatId, success: false, error: err.message });
      }
      if (i < recipients.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/recipients
app.get('/api/recipients', async (req, res) => {
  try {
    const recipients = await readRecipients();
    res.json(recipients);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/recipients
app.post('/api/recipients', async (req, res) => {
  const { name, chatId, username, note } = req.body;
  if (!name || !chatId) {
    return res.status(400).json({ success: false, error: 'name and chatId are required' });
  }
  try {
    const recipients = await readRecipients();
    const maxId = recipients.reduce((m, r) => Math.max(m, r.id || 0), 0);
    const newRecipient = { id: maxId + 1, name, chatId, username: username || '', note: note || '' };
    recipients.push(newRecipient);
    await writeRecipients(recipients);
    res.status(201).json(newRecipient);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/recipients/import
app.post('/api/recipients/import', async (req, res) => {
  const incoming = req.body;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ success: false, error: 'Body must be an array' });
  }
  try {
    const recipients = await readRecipients();
    const existingChatIds = new Set(recipients.map(r => r.chatId));
    let maxId = recipients.reduce((m, r) => Math.max(m, r.id || 0), 0);
    let added = 0;
    for (const item of incoming) {
      if (!item.chatId || existingChatIds.has(item.chatId)) continue;
      maxId++;
      recipients.push({ id: maxId, name: item.name || item.chatId, chatId: item.chatId, username: item.username || '', note: item.note || '' });
      existingChatIds.add(item.chatId);
      added++;
    }
    await writeRecipients(recipients);
    res.json({ success: true, added, total: recipients.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/recipients/:id
app.put('/api/recipients/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const recipients = await readRecipients();
    const idx = recipients.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Recipient not found' });
    recipients[idx] = { ...recipients[idx], ...req.body, id };
    await writeRecipients(recipients);
    res.json(recipients[idx]);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/recipients/:id
app.delete('/api/recipients/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    let recipients = await readRecipients();
    const idx = recipients.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Recipient not found' });
    recipients.splice(idx, 1);
    await writeRecipients(recipients);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Beeper Instagram Messenger running at http://localhost:${PORT}`);
});
