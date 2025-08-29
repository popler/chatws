// logger.js
import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || '/var/log/vls-chat';
const FLUSH_MS = Number(process.env.LOG_FLUSH_MS || 10000);

// utwórz katalog na logi (jeśli nie istnieje)
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const buffers = new Map(); // room -> string[]

function line(ts, room, type, payload) {
  // prosty TSV: ISO, room, type, json
  const iso = new Date(ts).toISOString();
  return `${iso}\t${room}\t${type}\t${JSON.stringify(payload)}\n`;
}

export function logMessage(room, msgObj) {
  if (!room) return;
  const arr = buffers.get(room) || [];
  arr.push(line(msgObj.ts || Date.now(), room, msgObj.type || 'message', msgObj));
  buffers.set(room, arr);
}

export function logAdmin(room, actionObj) {
  if (!room) return;
  const arr = buffers.get(room) || [];
  arr.push(line(actionObj.ts || Date.now(), room, 'admin', actionObj));
  buffers.set(room, arr);
}

function flushRoom(room, lines) {
  if (!lines?.length) return;
  const file = path.join(LOG_DIR, `room-${room}.log`);
  try { fs.appendFileSync(file, lines.join(''), 'utf8'); } catch {}
}

function flushAll() {
  for (const [room, arr] of buffers) {
    if (!arr.length) continue;
    buffers.set(room, []);
    flushRoom(room, arr);
  }
}

const interval = setInterval(flushAll, FLUSH_MS);

// pozwól na czyste zamknięcie
export async function closeLogger() {
  clearInterval(interval);
  flushAll();
}
