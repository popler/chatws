// server-ws.js
// WebSocket serwer (ws) z obsługą admina, historii, reakcji, presence, slow-mode, timeout/ban + LOGI
import 'dotenv/config';
import http from 'http';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { ulid } from 'ulid';
import { logMessage, logAdmin, closeLogger } from './logger.js';

const WS_PORT    = Number(process.env.WS_PORT || process.env.PORT_WS || 8080);
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const redis      = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

// ===== Helpers/keyspace =====
const kRoomSet      = 'chat:rooms';
const kRoomUsers    = (room) => `chat:room:${room}:users`;
const kRoomMeta     = (room) => `chat:room:${room}`;
const kUserHash     = (uid)  => `chat:user:${uid}`;
const kHistory      = (room) => `chat:room:${room}:history`;
const kAudit        = (room) => `chat:audit:${room}`;
const kBan          = (room, uid) => `chat:room:${room}:ban:${uid}`;
const kTimeout      = (room, uid) => `chat:room:${room}:timeout:${uid}`;
const kHold         = (room, nickLower) => `chat:room:${room}:name:${nickLower}:hold`;

const HISTORY_MAX = Number(process.env.HISTORY_MAX || 500);

// pamięć lokalna połączeń
const rooms = new Map(); // room -> Set<ws>
function roomSet(room) {
  let s = rooms.get(room);
  if (!s) { s = new Set(); rooms.set(room, s); }
  return s;
}

function broadcast(room, obj, excludeWS = null) {
  const payload = JSON.stringify(obj);
  for (const ws of roomSet(room)) {
    if (ws !== excludeWS && ws.readyState === ws.OPEN) {
      try { ws.send(payload); } catch {}
    }
  }
}

const now = () => Date.now();

async function getSlow(room) {
  const v = await redis.hget(kRoomMeta(room), 'slow');
  if (!v) return 0;
  if (!/^\d+s$/i.test(v)) return 0;
  const n = parseInt(v, 10);
  return isFinite(n) && n > 0 ? n * 1000 : 0;
}

async function pushPresence(room) {
  const n = rooms.get(room)?.size || 0;
  broadcast(room, { type: 'presence', occupants: n });
}

async function pushHistory(ws, room) {
  const arr = await redis.lrange(kHistory(room), 0, 49);
  if (!arr?.length) return;
  const items = arr.reverse().map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  ws.send(JSON.stringify({ type: 'history', items }));
}

async function audit(room, entry) {
  try {
    const rec = Object.assign({ ts: now() }, entry);
    await redis.lpush(kAudit(room), JSON.stringify(rec));
    await redis.ltrim(kAudit(room), 0, 999);
  } catch {}
}

// ===== HTTP serwer tylko do /health + upgrade do WS =====
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: now() }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { url } = req;
  if (!url || !url.startsWith('/chat/ws')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// ===== Obsługa połączeń WS =====
wss.on('connection', async (ws, req) => {
  // auth z JWT
  const u = new URL(req.url, 'http://x');
  const token = u.searchParams.get('token') || '';
  let payload = null;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { ws.close(4000, 'bad token'); return; }

  const room = String(payload.room || 'demo').trim();
  const userId = String(payload.userId || '').trim();
  const name = String(payload.displayName || 'Anon').trim();
  const nameLower = String(payload.displayNameLower || name.toLowerCase()).trim();
  const role = payload.role === 'admin' ? 'admin' : 'user';

  // unikalność nicka – sprawdź hold w Redis
  try {
    const holdVal = await redis.get(kHold(room, nameLower));
    if (holdVal !== userId) { ws.close(4001, 'name not reserved'); return; }
    await redis.del(kHold(room, nameLower)); // zwalniamy, by nie wisiało
  } catch {
    ws.close(4002, 'hold check failed'); return;
  }

  // presence w Redis
  try {
    await redis.sadd(kRoomSet, room);
    await redis.sadd(kRoomUsers(room), userId);
    await redis.hset(kUserHash(userId), { name, room, sinceTs: String(now()), lastTs: String(now()), msg: '0' });
    await redis.hsetnx(kRoomMeta(room), 'sinceTs', String(now()));
  } catch {}

  // presence lokalnie
  roomSet(room).add(ws);

  // meta
  ws.meta = { room, userId, name, role, lastSendAt: 0 };

  // hello/presence/history
  try { ws.send(JSON.stringify({ type: 'hello', occupants: rooms.get(room)?.size || 1 })); } catch {}
  pushPresence(room).catch(()=>{});
  pushHistory(ws, room).catch(()=>{});

  // keepalive
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (data) => {
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // policy: ban/timeout
    const isBanned = await redis.get(kBan(room, userId));
    if (isBanned) return;
    const toLeft = await redis.pttl(kTimeout(room, userId));
    if (toLeft && toLeft > 0) return;

    if (msg.type === 'typing') {
      broadcast(room, { type: 'typing', user: { id: userId, name } }, ws);
      return;
    }

    if (msg.type === 'message') {
      const text = String(msg.text || '').slice(0, 2000);
      if (!text) return;

      const slowMs = await getSlow(room);
      if (slowMs > 0) {
        const nowTs = now();
        if (nowTs - (ws.meta.lastSendAt || 0) < slowMs) return;
        ws.meta.lastSendAt = nowTs;
      }

      const id = ulid();
      const item = { type: 'message', id, room, text, ts: now(), user: { id: userId, name } };

      try {
        await redis.lpush(kHistory(room), JSON.stringify(item));
        await redis.ltrim(kHistory(room), 0, HISTORY_MAX - 1);
        await redis.hincrby(kUserHash(userId), 'msg', 1);
        await redis.hset(kUserHash(userId), 'lastTs', String(now()));
      } catch {}

      // LOG
      try { logMessage(room, item); } catch {}

      broadcast(room, item);
      return;
    }

    if (msg.type === 'reaction') {
      const id = String(msg.id || '');
      const emoji = String(msg.emoji || '').slice(0, 16);
      const delta = Number.isFinite(msg.delta) ? Number(msg.delta) : 1;
      if (!id || !emoji) return;
      broadcast(room, { type: 'reaction', id, emoji, delta });
      return;
    }

    // ===== ADMIN =====
    if (msg.type === 'admin') {
      if (role !== 'admin') return;
      const action = String(msg.action || '');

      if (action === 'announce') {
        const text = String(msg.text || '').slice(0, 2000);
        if (!text) return;
        broadcast(room, { type: 'announce', text });
        const rec = { action: 'announce', by: userId, name, text, ts: now() };
        audit(room, rec).catch(()=>{});
        try { logAdmin(room, rec); } catch {}
        return;
      }

      if (action === 'clear') {
        broadcast(room, { type: 'moderate', action: 'clear' });
        const rec = { action: 'clear', by: userId, name, ts: now() };
        audit(room, rec).catch(()=>{});
        try { logAdmin(room, rec); } catch {}
        return;
      }

      if (action === 'slow') {
        let value = String(msg.value || 'off').toLowerCase();
        if (value !== 'off' && !/^\d+s$/.test(value)) value = 'off';
        await redis.hset(kRoomMeta(room), 'slow', value);
        broadcast(room, { type: 'moderate', action: 'slow', value });
        const rec = { action: 'slow', value, by: userId, name, ts: now() };
        audit(room, rec).catch(()=>{});
        try { logAdmin(room, rec); } catch {}
        return;
      }

      if (action === 'timeout') {
        const uid = String(msg.userId || '');
        const minutes = Math.max(1, parseInt(msg.minutes || '5', 10));
        if (!uid) return;
        await redis.set(kTimeout(room, uid), '1', 'EX', minutes * 60);
        broadcast(room, { type: 'moderate', action: 'timeout', userId: uid, minutes });
        const rec = { action: 'timeout', userId: uid, minutes, by: userId, name, ts: now() };
        audit(room, rec).catch(()=>{});
        try { logAdmin(room, rec); } catch {}
        return;
      }

      if (action === 'ban') {
        const uid = String(msg.userId || '');
        if (!uid) return;
        await redis.set(kBan(room, uid), '1');
        broadcast(room, { type: 'moderate', action: 'ban', userId: uid });
        const rec = { action: 'ban', userId: uid, by: userId, name, ts: now() };
        audit(room, rec).catch(()=>{});
        try { logAdmin(room, rec); } catch {}
        return;
      }

      if (action === 'purge') {
        const uid = String(msg.userId || '');
        if (!uid) return;
        broadcast(room, { type: 'moderate', action: 'purge', userId: uid });
        const rec = { action: 'purge', userId: uid, by: userId, name, ts: now() };
        audit(room, rec).catch(()=>{});
        try { logAdmin(room, rec); } catch {}
        return;
      }

      if (action === 'delete') {
        const id = String(msg.id || '');
        if (!id) return;
        broadcast(room, { type: 'moderate', action: 'delete', id });
        const rec = { action: 'delete', id, by: userId, name, ts: now() };
        audit(room, rec).catch(()=>{});
        try { logAdmin(room, rec); } catch {}
        return;
      }
    }
  });

  ws.on('close', async () => {
    roomSet(room).delete(ws);
    pushPresence(room).catch(()=>{});
    try { await redis.srem(kRoomUsers(room), userId); } catch {}
  });
});

// keepalive: ping co 30s
const pingInterval = setInterval(() => {
  for (const set of rooms.values()) {
    for (const ws of set) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }
}, 30000);

// ===== GRACEFUL SHUTDOWN =====
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[chat] shutting down...');

  try { clearInterval(pingInterval); } catch {}

  await new Promise((res) => { try { server.close(() => res()); } catch { res(); } });

  try {
    const clients = Array.from(rooms.values()).flatMap(set => Array.from(set));
    for (const ws of clients) { try { ws.terminate(); } catch {} }
    await new Promise(r => setTimeout(r, 200));
    wss.close();
  } catch {}

  try { await closeLogger(); } catch {}
  try { await redis.quit(); } catch { try { redis.disconnect(); } catch {} }

  console.log('[chat] down.');
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT',  () => shutdown(0));
process.on('uncaughtException', (e) => { console.error('uncaught', e); shutdown(1); });
process.on('unhandledRejection', (e) => { console.error('unhandled', e); shutdown(1); });

server.listen(WS_PORT, () => {
  console.log(`[chat] ws on :${WS_PORT}/chat/ws (ws lib)`);
});
