require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3600;
const BEEPER_URL = process.env.BEEPER_URL || 'http://localhost:23373';
const RECIPIENTS_FILE = path.join(__dirname, 'recipients.json');
const AUTH_FILE = path.join(__dirname, '.beeper-auth.json');
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;

// ── Auth state (persisted across restarts) ──────────────────────────────────
let accessToken = null;
let clientId = null;
const pendingPKCE = new Map(); // state → code_verifier

async function loadAuth() {
  try {
    const data = JSON.parse(await fs.readFile(AUTH_FILE, 'utf8'));
    accessToken = data.accessToken || null;
    clientId = data.clientId || null;
  } catch { /* no saved auth yet */ }
}

async function saveAuth() {
  await fs.writeFile(AUTH_FILE, JSON.stringify({ accessToken, clientId }, null, 2), 'utf8');
}

async function ensureClientId() {
  if (clientId) return clientId;
  const r = await axios.post(`${BEEPER_URL}/oauth/register`, {
    client_name: 'beeper-instagram-messeger',
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  clientId = r.data.client_id;
  await saveAuth();
  return clientId;
}

function getBeeperClient() {
  if (!accessToken) throw new Error('Not authenticated. Connect to Beeper first via the UI.');
  return axios.create({
    baseURL: BEEPER_URL,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── OAuth2 PKCE endpoints ────────────────────────────────────────────────────

// GET /oauth/start — kick off the PKCE authorization flow
app.get('/oauth/start', async (req, res) => {
  try {
    const cid = await ensureClientId();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    pendingPKCE.set(state, verifier);

    const url = new URL(`${BEEPER_URL}/oauth/authorize`);
    url.searchParams.set('client_id', cid);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', 'read write');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  } catch (err) {
    res.redirect(`/?auth=error&msg=${encodeURIComponent(err.message)}`);
  }
});

// GET /oauth/callback — exchange authorization code for access token
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?auth=error&msg=${encodeURIComponent(error)}`);

  const verifier = pendingPKCE.get(state);
  if (!verifier) return res.redirect('/?auth=error&msg=invalid_state');
  pendingPKCE.delete(state);

  try {
    const r = await axios.post(`${BEEPER_URL}/oauth/token`, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    accessToken = r.data.access_token;
    await saveAuth();
    res.redirect('/?auth=success');
  } catch (err) {
    const msg = err.response?.data?.error_description || err.message;
    res.redirect(`/?auth=error&msg=${encodeURIComponent(msg)}`);
  }
});

// POST /api/disconnect — clear stored token
app.post('/api/disconnect', async (req, res) => {
  accessToken = null;
  await saveAuth();
  res.json({ success: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// Extract username from a Facebook URL (handles pages, profiles, etc.)
function extractFacebookUsername(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
}

// Resolve chatId for a recipient (if missing, start chat via username) and persist it
// accountsCache: pre-fetched accounts array to avoid repeated /v1/accounts calls
async function resolveRecipientChat(beeper, recipient, allRecipients, accountsCache) {
  if (recipient.chatId) return recipient.chatId;
  if (!recipient.username) throw new Error(`Recipient "${recipient.name}" has no chatId or username`);

  const network = recipient.network || 'facebook';
  const accounts = accountsCache || (await beeper.get('/v1/accounts')).data;
  const account = accounts.find(a => a.accountID?.toLowerCase().includes(network.toLowerCase()));
  if (!account) throw new Error(`No ${network} account connected in Beeper`);

  const chatRes = await beeper.post('/v1/chats', {
    accountID: account.accountID,
    mode: 'start',
    user: { username: recipient.username },
  });
  const chatId = chatRes.data.chatID;

  // Persist resolved chatId so future sends skip this step
  const idx = allRecipients.findIndex(r => r.id === recipient.id);
  if (idx !== -1) {
    allRecipients[idx].chatId = chatId;
    await writeRecipients(allRecipients);
  }
  return chatId;
}

// ── API routes ───────────────────────────────────────────────────────────────

// GET /api/status
app.get('/api/status', async (req, res) => {
  if (!accessToken) {
    return res.json({ authenticated: false, connected: false });
  }
  try {
    const beeper = getBeeperClient();
    const r = await beeper.get('/v1/accounts');
    res.json({ authenticated: true, connected: true, accounts: r.data });
  } catch (err) {
    if (err.response?.status === 401) {
      accessToken = null;
      await saveAuth();
      return res.json({ authenticated: false, connected: false, error: 'Token expired' });
    }
    res.json({ authenticated: true, connected: false, error: err.message });
  }
});

// POST /api/send-to-username — start/find a chat with a user on a given network and send a message
app.post('/api/send-to-username', async (req, res) => {
  const { username, message, network = 'instagram' } = req.body;
  if (!username || !message) {
    return res.status(400).json({ success: false, error: 'username and message are required' });
  }
  try {
    const beeper = getBeeperClient();
    const accountsRes = await beeper.get('/v1/accounts');
    const account = accountsRes.data.find(a => a.accountID?.toLowerCase().includes(network.toLowerCase()));
    if (!account) {
      return res.status(400).json({ success: false, error: `No ${network} account connected in Beeper` });
    }
    const chatRes = await beeper.post('/v1/chats', {
      accountID: account.accountID,
      mode: 'start',
      user: { username },
    });
    const chatId = chatRes.data.chatID;
    const msgRes = await beeper.post(`/v1/chats/${encodeURIComponent(chatId)}/messages`, { text: message });
    res.json({ success: true, chatId, result: msgRes.data });
  } catch (err) {
    const status = err.response?.status ?? 500;
    res.status(status).json({ success: false, error: err.response?.data?.message || err.message });
  }
});

// GET /api/chats — list chats from Beeper filtered by network (instagram|facebook)
app.get('/api/chats', async (req, res) => {
  const network = (req.query.network || 'instagram').toLowerCase();
  try {
    const beeper = getBeeperClient();
    const r = await beeper.get('/v1/chats', { params: { limit: 100 } });
    const items = r.data?.items ?? (Array.isArray(r.data) ? r.data : []);
    const chats = items
      .filter(c => c.accountID?.toLowerCase().includes(network))
      .map(c => ({
        chatId: c.id,
        name: c.title || c.id,
        accountId: c.accountID,
        network,
        username: c.participants?.items?.find(p => !p.isSelf)?.username || c.title || '',
      }));
    res.json(chats);
  } catch (err) {
    const status = err.response?.status ?? 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// POST /api/send — send message to a single chat
app.post('/api/send', async (req, res) => {
  const { chatId, message } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ success: false, error: 'chatId and message are required' });
  }
  try {
    const beeper = getBeeperClient();
    const r = await beeper.post(`/v1/chats/${encodeURIComponent(chatId)}/messages`, { text: message });
    res.json({ success: true, result: r.data });
  } catch (err) {
    const status = err.response?.status ?? 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// GET /api/broadcast — SSE stream for broadcast progress
app.get('/api/broadcast', (req, res) => {
  res.status(405).json({ success: false, error: 'Use POST /api/broadcast to start a broadcast' });
});

// POST /api/broadcast — send same message to multiple recipients (streams SSE progress)
app.post('/api/broadcast', async (req, res) => {
  const { message, ids, network, delay: delayMs = 2000 } = req.body;
  if (!message) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }

  // Use SSE to stream progress to the client
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const beeper = getBeeperClient();
    let all = await readRecipients();
    let recipients = all;

    // Filter by explicit ids list
    if (ids && Array.isArray(ids) && ids.length > 0) {
      recipients = recipients.filter(r => ids.includes(r.id));
    } else if (network) {
      // Filter by network when sending to all
      recipients = recipients.filter(r => (r.network || 'instagram') === network);
    }

    send('start', { total: recipients.length });

    // Fetch accounts once — reused for every recipient that needs chatId resolution
    const accountsRes = await beeper.get('/v1/accounts');
    const accounts = accountsRes.data;

    const results = [];
    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      try {
        const chatId = await resolveRecipientChat(beeper, recipient, all, accounts);
        await beeper.post(`/v1/chats/${encodeURIComponent(chatId)}/messages`, { text: message });
        const result = { id: recipient.id, name: recipient.name, chatId, success: true };
        results.push(result);
        send('result', result);
      } catch (err) {
        const result = { id: recipient.id, name: recipient.name, chatId: recipient.chatId || '', success: false, error: err.message };
        results.push(result);
        send('result', result);
      }
      if (i < recipients.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    const ok = results.filter(r => r.success).length;
    send('done', { success: true, total: recipients.length, sent: ok, failed: recipients.length - ok });
  } catch (err) {
    send('error', { success: false, error: err.message });
  }

  res.end();
});

// GET /api/recipients
app.get('/api/recipients', async (req, res) => {
  try {
    res.json(await readRecipients());
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/recipients
app.post('/api/recipients', async (req, res) => {
  const { name, chatId, username, note, network = 'instagram' } = req.body;
  if (!name || !chatId) {
    return res.status(400).json({ success: false, error: 'name and chatId are required' });
  }
  try {
    const recipients = await readRecipients();
    const maxId = recipients.reduce((m, r) => Math.max(m, r.id || 0), 0);
    const newRecipient = { id: maxId + 1, name, chatId, username: username || '', note: note || '', network };
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
    const existingChatIds = new Set(recipients.map(r => r.chatId).filter(Boolean));
    const existingUsernames = new Set(recipients.map(r => `${r.network || 'instagram'}:${r.username}`).filter(u => !u.endsWith(':')));
    let maxId = recipients.reduce((m, r) => Math.max(m, r.id || 0), 0);
    let added = 0;

    for (const item of incoming) {
      // ── Detect copilot-find-new-clients Instagram format (has instagramUrl or username+no chatId/facebook) ──
      if (item.instagramUrl || (item.username && !item.chatId && !item.facebook)) {
        const username = item.username || extractFacebookUsername(item.instagramUrl);
        if (!username) continue;
        const key = `instagram:${username}`;
        if (existingUsernames.has(key)) continue;
        maxId++;
        recipients.push({
          id: maxId,
          name: item.name || username,
          chatId: '',
          username,
          network: 'instagram',
          note: [item.bio ? item.bio.slice(0, 80) : '', item.city, item.email].filter(Boolean).join(' | '),
        });
        existingUsernames.add(key);
        added++;
        continue;
      }

      // ── Detect copilot-find-new-clients Facebook format (has 'facebook' URL field) ──
      if (item.facebook && !item.chatId) {
        const username = extractFacebookUsername(item.facebook);
        if (!username) continue;
        const key = `facebook:${username}`;
        if (existingUsernames.has(key)) continue;
        maxId++;
        recipients.push({
          id: maxId,
          name: item.name || username,
          chatId: '',
          username,
          network: 'facebook',
          note: [item.types, item.city, item.phone].filter(Boolean).join(' | '),
        });
        existingUsernames.add(key);
        added++;
        continue;
      }

      // ── Standard format (has chatId) ──
      if (!item.chatId || existingChatIds.has(item.chatId)) continue;
      maxId++;
      recipients.push({
        id: maxId,
        name: item.name || item.chatId,
        chatId: item.chatId,
        username: item.username || '',
        note: item.note || '',
        network: item.network || 'instagram',
      });
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

// DELETE /api/recipients — bulk delete by ids or network
// Body: { ids: [1,2,3] }  OR  { network: 'instagram' }  OR {} to delete all
app.delete('/api/recipients', async (req, res) => {
  const { ids, network } = req.body;
  try {
    let recipients = await readRecipients();
    const before = recipients.length;
    if (Array.isArray(ids) && ids.length > 0) {
      const idSet = new Set(ids);
      recipients = recipients.filter(r => !idSet.has(r.id));
    } else if (network) {
      recipients = recipients.filter(r => (r.network || 'instagram') !== network);
    } else {
      recipients = [];
    }
    await writeRecipients(recipients);
    res.json({ success: true, removed: before - recipients.length, total: recipients.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
loadAuth().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   💬  Beeper Messenger  v2.0.0               ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  UI: http://localhost:${PORT}                  ║`);
    console.log('╠══════════════════════════════════════════════╣');
    console.log('║  Networks: Instagram + Facebook Messenger    ║');
    console.log('║  Auth handled automatically via OAuth2 PKCE  ║');
    console.log('║  No BEEPER_ACCESS_TOKEN needed!              ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(accessToken ? '✅ Authenticated (token loaded from file)' : '⚠️  Not authenticated — open the UI and click Connect');
    console.log('');
  });
});
