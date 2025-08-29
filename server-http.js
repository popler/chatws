// server-http.js
// HTTP API: join, audit, roster (rooms, users), export CSV logów + rezerwacja nicka (unikalność w pokoju)

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import readline from 'readline';

const app = express();
const PORT = Number(process.env.HTTP_PORT || process.env.PORT_HTTP || 8081);
const ORIGIN = process.env.CORS_ORIGIN || 'https://videolivesystem.pl';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const LOG_DIR = process.env.LOG_DIR || '/var/log/vls-chat';
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

app.set('trust proxy', 1); // bezpieczny tryb (1 hop od Nginx)
app.use(express.json({ limit: '256kb' }));

// CORS – jeden komplet nagłówków (Nginx też je dodaje, ale tu jest wygodnie dla narzędzi)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// =======================
// Helpers
// =======================
const ADMINS_FILE = process.env.ADMINS_FILE || path.join(process.cwd(), 'admins.json');
function loadAdmins() {
  try {
    const raw = fs.readFileSync(ADMINS_FILE, 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : {};
  } catch {
    return {};
  }
}
function normalizeNick(n) { return String(n || '').trim(); }
function toKeyNick(n) { return normalizeNick(n).toLowerCase(); }
function isNickValid(n) { return /^[a-zA-Z0-9._\- ]{2,40}$/.test(n); }
function safeRoomName(room) { return String(room || '').replace(/[^a-zA-Z0-9._\-]/g, '_'); }
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// =======================
// Rate-limit tylko na join (np. 30/min)
// =======================
const joinLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many join attempts, try later' },
});
app.use('/chat/api/join', joinLimiter);

// =======================
// /chat/api/join
// body: { room, displayName, password? }  -> { token, role }
// =======================
app.post('/chat/api/join', async (req, res) => {
  try {
    const room = String(req.body?.room || '').trim() || 'demo';
    const displayNameRaw = normalizeNick(req.body?.displayName);
    const password = String(req.body?.password || '');

    if (!displayNameRaw) return res.status(400).json({ error: 'displayName required' });
    if (!isNickValid(displayNameRaw)) return res.status(400).json({ error: 'Nick nieprawidłowy' });

    const displayNameKey = toKeyNick(displayNameRaw);
    const userId = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

    // rola: user domyślnie, admin jeśli hash w admins.json pasuje
    let role = 'user';
    const admins = loadAdmins();
    const hash = admins[displayNameRaw];
    if (hash) {
      const ok = await bcrypt.compare(password, hash).catch(() => false);
      if (!ok) return res.status(401).json({ error: 'Invalid admin password' });
      role = 'admin';
    }

    // --- REZERWACJA NICKA (60s) ---
    // Jeśli ktoś już zarezerwował albo jest w pokoju → blokujemy.
    const holdKey = `chat:room:${room}:name:${displayNameKey}:hold`;
    const held = await redis.set(holdKey, userId, 'NX', 'EX', 60);
    if (held !== 'OK') {
      return res.status(400).json({ error: 'Nick zajęty' });
    }

    // Token przenosi info o nicku i rezerwacji
    const token = jwt.sign(
      {
        room,
        userId,
        displayName: displayNameRaw,      // oryginalna pisownia
        displayNameLower: displayNameKey, // do weryfikacji
        role,
      },
      JWT_SECRET,
      { expiresIn: '6h' }
    );

    res.json({ token, role });
  } catch (e) {
    console.error('join error', e);
    res.status(500).json({ error: 'server error' });
  }
});

// =======================
// AUTH middlewares dla admin REST
// =======================
function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Bad token' });
  }
  next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// =======================
// /chat/api/admin/audit
// =======================
app.get('/chat/api/admin/audit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const room = String(req.query.room || req.user?.room || 'demo').trim();
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '200', 10)));
    const key = `chat:audit:${room}`;
    const arr = await redis.lrange(key, 0, limit - 1);
    const items = arr.map(s => {
      try { return JSON.parse(s); } catch { return { raw: s }; }
    });
    res.json({ items });
  } catch (e) {
    console.error('audit error', e);
    res.status(500).json({ error: 'server error' });
  }
});

// =======================
// ROSTER: /chat/api/rooms
// =======================
app.get('/chat/api/rooms', requireAuth, requireAdmin, async (req, res) => {
  try {
    const names = await redis.smembers('chat:rooms');
    if (!names.length) return res.json({ rooms: [] });

    const pipe = redis.pipeline();
    names.forEach(r => pipe.scard(`chat:room:${r}:users`));
    names.forEach(r => pipe.hget(`chat:room:${r}`, 'sinceTs'));
    names.forEach(r => pipe.hget(`chat:room:${r}`, 'slow'));
    const out = await pipe.exec();

    const occ = out.slice(0, names.length).map(x => Number(x[1] || 0));
    const since = out.slice(names.length, names.length * 2).map(x => Number(x[1] || 0));
    const slow = out.slice(names.length * 2, names.length * 3).map(x => x[1] || 'off');

    const rooms = names.map((name, i) => ({
      name,
      occupants: occ[i] || 0,
      sinceTs: since[i] || 0,
      slow: slow[i] || 'off',
    })).sort((a, b) => (b.occupants || 0) - (a.occupants || 0) || a.name.localeCompare(b.name));

    res.json({ rooms });
  } catch (e) {
    console.error('rooms error', e);
    res.status(500).json({ error: 'server error' });
  }
});

// =======================
// ROSTER: /chat/api/rooms/:room/users
// =======================
app.get('/chat/api/rooms/:room/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const room = String(req.params.room || '').trim();
    if (!room) return res.status(400).json({ error: 'Bad room' });

    const ids = await redis.smembers(`chat:room:${room}:users`);
    if (!ids.length) return res.json({ users: [] });

    const pipe = redis.pipeline();
    ids.forEach(id => pipe.hmget(`chat:user:${id}`, 'name', 'room', 'sinceTs', 'lastTs', 'msg'));
    const out = await pipe.exec();

    const users = out.map((x, i) => {
      const [name, roomStored, sinceTs, lastTs, msg] = x[1];
      return {
        id: ids[i],
        name: name || '—',
        sinceTs: Number(sinceTs || 0),
        lastTs: Number(lastTs || 0),
        msg: Number(msg || 0),
        _room: roomStored || room,
      };
    });

    res.json({ users });
  } catch (e) {
    console.error('room users error', e);
    res.status(500).json({ error: 'server error' });
  }
});

// =======================
// EXPORT CSV: /chat/api/admin/log.csv?room=<room>
// Plik: LOG_DIR/room-<room>.log
// Format logu (TSV z logger.js):
//   ISO8601 \t <room> \t <event> \t <JSON>
// CSV zwracamy z kolumnami:
//   timestamp,room,event,id,userId,userName,text,action,minutes,value,raw
// =======================
app.get('/chat/api/admin/log.csv', requireAuth, requireAdmin, async (req, res) => {
  try {
    const roomReq = String(req.query.room || req.user?.room || '').trim();
    if (!roomReq) return res.status(400).json({ error: 'Bad room' });
    const room = safeRoomName(roomReq);
    const filePath = path.join(LOG_DIR, `room-${room}.log`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Log file not found' });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chat-${room}.csv"`);

    // Header CSV
    res.write([
      'timestamp',
      'room',
      'event',
      'id',
      'userId',
      'userName',
      'text',
      'action',
      'minutes',
      'value',
      'raw'
    ].join(',') + '\n');

    const rstream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: rstream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 4) continue;
      const [timestamp, roomName, event, jsonStr] = [parts[0], parts[1], parts[2], parts.slice(3).join('\t')];

      let id = '', userId = '', userName = '', text = '', action = '', minutes = '', value = '';
      let raw = '';

      try {
        const obj = JSON.parse(jsonStr);
        raw = JSON.stringify(obj);
        if (event === 'message') {
          id = obj.id || '';
          text = obj.text || '';
          if (obj.user) {
            userId = obj.user.id || '';
            userName = obj.user.name || '';
          }
        } else if (event === 'admin') {
          action = obj.action || '';
          // różne akcje mogą mieć różne pola:
          if (obj.id) id = obj.id;
          if (obj.userId) userId = obj.userId;
          if (obj.minutes != null) minutes = String(obj.minutes);
          if (obj.value != null) value = String(obj.value);
          if (obj.text) text = obj.text;
          if (obj.name) userName = obj.name; // admin name
        }
      } catch {
        raw = jsonStr;
      }

      const row = [
        csvEscape(timestamp),
        csvEscape(roomName),
        csvEscape(event),
        csvEscape(id),
        csvEscape(userId),
        csvEscape(userName),
        csvEscape(text),
        csvEscape(action),
        csvEscape(minutes),
        csvEscape(value),
        csvEscape(raw)
      ].join(',') + '\n';

      if (!res.write(row)) {
        // Backpressure – poczekaj aż strumień odpompuje
        await new Promise(resolve => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (e) {
    console.error('log.csv error', e);
    if (!res.headersSent) res.status(500).json({ error: 'server error' });
    else res.end();
  }
});

// =======================
// Health
// =======================
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`[http] on :${PORT}`);
});
