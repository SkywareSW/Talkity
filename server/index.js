'use strict';
/* ═══════════════════════════════════════════════════════════════════
   TALKITY SERVER  –  v4  (Phase 1 upgrade)
   New vs v3:
   ─ SQLite persistence via better-sqlite3 (chat history survives restarts)
   ─ Group chat rooms (create, join, leave, room messages)
   ─ File sharing (multer disk storage, served as static files)
   ─ Reactions persisted to DB
   ─ User profiles (bio, custom avatar URL)
   ─ Friends list with pending requests
   ═══════════════════════════════════════════════════════════════════ */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Upload directory ──────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Serve uploaded files statically
app.use('/uploads', express.static(UPLOADS_DIR));

// ── SQLite setup ──────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'talkity.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username    TEXT PRIMARY KEY,
    avatar      INTEGER NOT NULL DEFAULT 0,
    avatar_url  TEXT,
    bio         TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'online',
    mood        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    room_id     TEXT NOT NULL,
    from_user   TEXT NOT NULL,
    to_user     TEXT,
    text        TEXT NOT NULL DEFAULT '',
    image       TEXT,
    file_url    TEXT,
    file_name   TEXT,
    edited      INTEGER NOT NULL DEFAULT 0,
    deleted     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);

  CREATE TABLE IF NOT EXISTS reactions (
    msg_id      TEXT NOT NULL,
    username    TEXT NOT NULL,
    emoji       TEXT NOT NULL,
    PRIMARY KEY (msg_id, username, emoji)
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id     TEXT NOT NULL,
    username    TEXT NOT NULL,
    joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, username)
  );

  CREATE TABLE IF NOT EXISTS friends (
    requester   TEXT NOT NULL,
    addressee   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (requester, addressee)
  );
`);

// Prepared statements for hot paths
const stmts = {
  upsertUser:   db.prepare(`INSERT INTO users (username, avatar, status, mood) VALUES (?,?,?,?)
                             ON CONFLICT(username) DO UPDATE SET status=excluded.status, mood=excluded.mood`),
  getUser:      db.prepare(`SELECT * FROM users WHERE username = ?`),
  updateProfile:db.prepare(`UPDATE users SET avatar=?, avatar_url=?, bio=?, mood=?, status=? WHERE username=?`),

  insertMsg:    db.prepare(`INSERT INTO messages (id, room_id, from_user, to_user, text, image, file_url, file_name, created_at)
                             VALUES (?,?,?,?,?,?,?,?,?)`),
  getHistory:   db.prepare(`SELECT m.*, GROUP_CONCAT(r.username||':'||r.emoji,'|') as reaction_list
                             FROM messages m
                             LEFT JOIN reactions r ON r.msg_id = m.id
                             WHERE m.room_id = ? AND m.deleted = 0
                             GROUP BY m.id
                             ORDER BY m.created_at ASC LIMIT 200`),
  editMsg:      db.prepare(`UPDATE messages SET text=?, edited=1 WHERE id=? AND from_user=?`),
  deleteMsg:    db.prepare(`UPDATE messages SET deleted=1 WHERE id=? AND from_user=?`),

  upsertReaction: db.prepare(`INSERT OR IGNORE INTO reactions (msg_id, username, emoji) VALUES (?,?,?)`),
  removeReaction: db.prepare(`DELETE FROM reactions WHERE msg_id=? AND username=? AND emoji=?`),
  getReaction:    db.prepare(`SELECT * FROM reactions WHERE msg_id=? AND username=? AND emoji=?`),
  getMsgReactions:db.prepare(`SELECT emoji, username FROM reactions WHERE msg_id=?`),

  createRoom:   db.prepare(`INSERT OR IGNORE INTO rooms (id, name, description, created_by) VALUES (?,?,?,?)`),
  getRooms:     db.prepare(`SELECT * FROM rooms ORDER BY created_at ASC`),
  getRoom:      db.prepare(`SELECT * FROM rooms WHERE id=?`),
  joinRoom:     db.prepare(`INSERT OR IGNORE INTO room_members (room_id, username) VALUES (?,?)`),
  leaveRoom:    db.prepare(`DELETE FROM room_members WHERE room_id=? AND username=?`),
  getRoomMembers: db.prepare(`SELECT username FROM room_members WHERE room_id=?`),
  getUserRooms: db.prepare(`SELECT r.* FROM rooms r JOIN room_members rm ON rm.room_id=r.id WHERE rm.username=?`),

  sendFriendReq: db.prepare(`INSERT OR IGNORE INTO friends (requester, addressee) VALUES (?,?)`),
  acceptFriend:  db.prepare(`UPDATE friends SET status='accepted' WHERE requester=? AND addressee=?`),
  removeFriend:  db.prepare(`DELETE FROM friends WHERE (requester=? AND addressee=?) OR (requester=? AND addressee=?)`),
  getFriends:    db.prepare(`SELECT * FROM friends WHERE (requester=? OR addressee=?)`),
};

// ── HTTP / Socket.io ──────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: false },
  maxHttpBufferSize: 1e7,
  transports: ['polling', 'websocket'],
});
const PORT = process.env.PORT || 3747;

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ── File upload endpoint ──────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename:    (_, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safe);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_, file, cb) => {
    // Allow images + common docs
    const ok = /\.(jpg|jpeg|png|gif|webp|pdf|txt|zip|mp4|mp3|wav)$/i.test(file.originalname);
    cb(null, ok);
  },
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file or type not allowed' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, name: req.file.originalname, size: req.file.size });
});

// ── In-memory online presence ─────────────────────────────────────
const onlineUsers  = new Map(); // socketId → { username, avatar, avatarUrl, status, mood }
const userSockets  = new Map(); // username → socketId

function getRoomId(a, b) { return [a, b].sort().join('::'); }

function broadcastUserList() {
  const list = Array.from(onlineUsers.values()).map(u => ({
    username:  u.username,
    avatar:    u.avatar,
    avatarUrl: u.avatarUrl || null,
    status:    u.status,
    mood:      u.mood,
  }));
  io.emit('users:list', list);
}

// Hydrate reactions from DB for a list of messages
function hydrateReactions(msgs) {
  return msgs.map(msg => {
    const rows = stmts.getMsgReactions.all(msg.id);
    const reactionMap = {};
    rows.forEach(r => {
      if (!reactionMap[r.emoji]) reactionMap[r.emoji] = [];
      reactionMap[r.emoji].push(r.username);
    });
    return { ...msg, reactions: reactionMap };
  });
}

// ── Socket events ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[talkity] socket connected: ${socket.id}`);

  // ── JOIN ──
  socket.on('user:join', ({ username, avatar, avatarUrl, status, mood }) => {
    if (!username) return;
    const user = {
      socketId: socket.id,
      username,
      avatar: avatar || 0,
      avatarUrl: avatarUrl || null,
      status: status || 'online',
      mood: mood || '',
    };
    onlineUsers.set(socket.id, user);
    userSockets.set(username, socket.id);

    // Upsert user in DB
    stmts.upsertUser.run(username, avatar || 0, status || 'online', mood || '');

    console.log(`[talkity] ${username} joined`);
    broadcastUserList();
    socket.emit('user:joined', { username, avatar: user.avatar });

    // Send room list and user's rooms
    const rooms = stmts.getRooms.all();
    socket.emit('rooms:list', rooms);

    // Re-join socket.io rooms the user is a member of
    const userRooms = stmts.getUserRooms.all(username);
    userRooms.forEach(room => socket.join('room:' + room.id));
  });

  // ── DIRECT MESSAGE ──
  socket.on('message:send', ({ to, text, image, fileUrl, fileName }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender || !to) return;
    if (!text && !image && !fileUrl) return;

    const roomId = getRoomId(sender.username, to);
    const msgId  = Date.now() + '_' + Math.random().toString(36).slice(2);
    const now    = new Date().toISOString();

    stmts.insertMsg.run(msgId, roomId, sender.username, to, text || '', image || null, fileUrl || null, fileName || null, now);

    const msg = { id: msgId, from: sender.username, to, text: text || '', image: image || null, fileUrl: fileUrl || null, fileName: fileName || null, time: now, reactions: {} };

    const recipientSid = userSockets.get(to);
    if (recipientSid) io.to(recipientSid).emit('message:receive', msg);
    socket.emit('message:sent', msg);
  });

  // ── ROOM MESSAGE ──
  socket.on('room:message', ({ roomId, text, fileUrl, fileName }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender || !roomId) return;
    if (!text && !fileUrl) return;

    const msgId = Date.now() + '_' + Math.random().toString(36).slice(2);
    const now   = new Date().toISOString();

    stmts.insertMsg.run(msgId, 'room:' + roomId, sender.username, null, text || '', null, fileUrl || null, fileName || null, now);

    const msg = { id: msgId, roomId, from: sender.username, text: text || '', fileUrl: fileUrl || null, fileName: fileName || null, time: now, reactions: {} };
    io.to('room:' + roomId).emit('room:message', msg);
  });

  // ── EDIT ──
  socket.on('message:edit', ({ id, to, text, roomId }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender || !id || !text) return;
    stmts.editMsg.run(text, id, sender.username);

    if (roomId) {
      io.to('room:' + roomId).emit('message:edited', { id, from: sender.username, text });
    } else {
      const sid = userSockets.get(to);
      if (sid) io.to(sid).emit('message:edited', { id, from: sender.username, text });
      socket.emit('message:edited', { id, from: sender.username, text });
    }
  });

  // ── DELETE ──
  socket.on('message:delete', ({ id, to, roomId }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender || !id) return;
    stmts.deleteMsg.run(id, sender.username);

    if (roomId) {
      io.to('room:' + roomId).emit('message:deleted', { id, from: sender.username });
    } else {
      const sid = userSockets.get(to);
      if (sid) io.to(sid).emit('message:deleted', { id, from: sender.username });
      socket.emit('message:deleted', { id, from: sender.username });
    }
  });

  // ── REACTIONS ──
  socket.on('message:react', ({ msgId, emoji, to, roomId }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender || !msgId || !emoji) return;

    const existing = stmts.getReaction.get(msgId, sender.username, emoji);
    if (existing) {
      stmts.removeReaction.run(msgId, sender.username, emoji);
    } else {
      stmts.upsertReaction.run(msgId, sender.username, emoji);
    }

    const payload = { msgId, emoji, from: sender.username, removed: !!existing };

    if (roomId) {
      io.to('room:' + roomId).emit('message:react', payload);
    } else if (to) {
      const sid = userSockets.get(to);
      if (sid) io.to(sid).emit('message:react', payload);
      socket.emit('message:react', payload);
    }
  });

  // ── TYPING ──
  socket.on('typing:start', ({ to, roomId }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender) return;
    if (roomId) {
      socket.to('room:' + roomId).emit('typing:start', { from: sender.username, roomId });
    } else {
      const sid = userSockets.get(to);
      if (sid) io.to(sid).emit('typing:start', { from: sender.username });
    }
  });

  socket.on('typing:stop', ({ to, roomId }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender) return;
    if (roomId) {
      socket.to('room:' + roomId).emit('typing:stop', { from: sender.username, roomId });
    } else {
      const sid = userSockets.get(to);
      if (sid) io.to(sid).emit('typing:stop', { from: sender.username });
    }
  });

  // ── NUDGE ──
  socket.on('nudge:send', ({ to }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender) return;
    const sid = userSockets.get(to);
    if (sid) io.to(sid).emit('nudge:receive', { from: sender.username });
  });

  // ── STATUS ──
  socket.on('user:status', ({ status, mood }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    user.status = status || user.status;
    user.mood   = mood !== undefined ? mood : user.mood;
    onlineUsers.set(socket.id, user);
    db.prepare('UPDATE users SET status=?, mood=? WHERE username=?').run(user.status, user.mood, user.username);
    broadcastUserList();
  });

  // ── HISTORY (DM) ──
  socket.on('history:get', ({ with: partner }) => {
    const self = onlineUsers.get(socket.id);
    if (!self) return;
    const roomId  = getRoomId(self.username, partner);
    const rawMsgs = stmts.getHistory.all(roomId);
    const msgs    = hydrateReactions(rawMsgs);
    socket.emit('history:data', { with: partner, messages: msgs });
  });

  // ── READ RECEIPTS ──
  socket.on('message:seen', ({ to }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender) return;
    const sid = userSockets.get(to);
    if (sid) io.to(sid).emit('message:seen', { from: sender.username });
  });

  // ══ ROOMS ══

  socket.on('room:create', ({ name, description }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender || !name) return;
    const roomId = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    stmts.createRoom.run(roomId, name.trim(), description?.trim() || '', sender.username);
    stmts.joinRoom.run(roomId, sender.username);
    socket.join('room:' + roomId);

    const room = stmts.getRoom.get(roomId);
    io.emit('room:created', room);
    socket.emit('room:joined', { roomId, name: room.name });
  });

  socket.on('room:join', ({ roomId }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender || !roomId) return;
    stmts.joinRoom.run(roomId, sender.username);
    socket.join('room:' + roomId);

    const room = stmts.getRoom.get(roomId);
    if (!room) return;
    socket.emit('room:joined', { roomId, name: room.name });

    // Send room history
    const rawMsgs = stmts.getHistory.all('room:' + roomId);
    const msgs    = hydrateReactions(rawMsgs);
    socket.emit('room:history', { roomId, messages: msgs });

    // Tell others in room
    socket.to('room:' + roomId).emit('room:member_joined', { roomId, username: sender.username });
  });

  socket.on('room:leave', ({ roomId }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender) return;
    stmts.leaveRoom.run(roomId, sender.username);
    socket.leave('room:' + roomId);
    socket.to('room:' + roomId).emit('room:member_left', { roomId, username: sender.username });
    socket.emit('room:left', { roomId });
  });

  socket.on('room:history', ({ roomId }) => {
    const rawMsgs = stmts.getHistory.all('room:' + roomId);
    const msgs    = hydrateReactions(rawMsgs);
    socket.emit('room:history', { roomId, messages: msgs });
  });

  socket.on('room:members', ({ roomId }) => {
    const rows = stmts.getRoomMembers.all(roomId);
    socket.emit('room:members', { roomId, members: rows.map(r => r.username) });
  });

  // ══ PROFILES ══

  socket.on('profile:update', ({ avatarUrl, bio, mood, avatar }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    user.avatarUrl = avatarUrl ?? user.avatarUrl;
    user.mood      = mood ?? user.mood;
    user.avatar    = avatar ?? user.avatar;
    onlineUsers.set(socket.id, user);
    stmts.updateProfile.run(user.avatar, user.avatarUrl, bio ?? '', user.mood, user.status, user.username);
    broadcastUserList();
    socket.emit('profile:updated', { ok: true });
  });

  socket.on('profile:get', ({ username }) => {
    const row = stmts.getUser.get(username);
    socket.emit('profile:data', row || null);
  });

  // ══ FRIENDS ══

  socket.on('friend:request', ({ to }) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender || !to || to === sender.username) return;
    stmts.sendFriendReq.run(sender.username, to);
    const sid = userSockets.get(to);
    if (sid) io.to(sid).emit('friend:request', { from: sender.username });
    socket.emit('friend:request_sent', { to });
  });

  socket.on('friend:accept', ({ from }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    stmts.acceptFriend.run(from, user.username);
    const sid = userSockets.get(from);
    if (sid) io.to(sid).emit('friend:accepted', { by: user.username });
    socket.emit('friend:accepted', { by: user.username });
  });

  socket.on('friend:remove', ({ username }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    stmts.removeFriend.run(user.username, username, username, user.username);
    socket.emit('friend:removed', { username });
  });

  socket.on('friend:list', () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    const rows = stmts.getFriends.all(user.username, user.username);
    socket.emit('friend:list', rows);
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      console.log(`[talkity] ${user.username} disconnected`);
      db.prepare('UPDATE users SET status=? WHERE username=?').run('offline', user.username);
      userSockets.delete(user.username);
      onlineUsers.delete(socket.id);
      broadcastUserList();
    }
  });
});

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const msgCount  = db.prepare('SELECT COUNT(*) as c FROM messages WHERE deleted=0').get().c;
  res.json({ ok: true, online: onlineUsers.size, users: userCount, messages: msgCount });
});

server.listen(PORT, () => {
  console.log(`\n  🫧 Talkity server v4 running on port ${PORT}\n`);
});