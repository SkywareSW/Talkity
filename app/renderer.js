/* ═══════════════════════════════════════════════════════════════════
   TALKITY  –  renderer.js v4
   New vs v3:
   ─ FEATURE: Group chat rooms (sidebar panel, create/join/leave, room messages)
   ─ FEATURE: File sharing (upload to server, download links in chat)
   ─ FEATURE: Persistent chat history (loaded from SQLite on server)
   ─ FEATURE: Reaction counts with persistence (server-backed)
   ─ FEATURE: User profile cards (bio, custom avatar URL, click to view)
   ─ FEATURE: Friends list with add/accept/remove
   ─ FEATURE: Dark / light theme toggle (CSS variable swap)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── AVATAR GENERATOR ───────────────────────────────────────────────
const AV_THEMES = [
  { bg1:'#78e8ff', bg2:'#1898f0', bg3:'#0858c0', skin:'rgba(215,240,255,.82)', feat:'rgba(5,25,90,.55)' },
  { bg1:'#ffcc70', bg2:'#e07020', bg3:'#a04000', skin:'rgba(255,228,175,.85)', feat:'rgba(100,35,0,.55)' },
  { bg1:'#90f090', bg2:'#28c840', bg3:'#108020', skin:'rgba(218,255,208,.8)',  feat:'rgba(0,58,10,.55)'  },
  { bg1:'#f090e8', bg2:'#d030c0', bg3:'#800880', skin:'rgba(255,208,238,.8)',  feat:'rgba(78,0,78,.55)'  },
  { bg1:'#ffe870', bg2:'#e0a000', bg3:'#906000', skin:'rgba(255,244,188,.85)', feat:'rgba(78,38,0,.5)'   },
  { bg1:'#70e8e8', bg2:'#10b8c8', bg3:'#087090', skin:'rgba(198,248,248,.8)',  feat:'rgba(0,48,68,.55)'  },
  { bg1:'#ff8888', bg2:'#e82020', bg3:'#900808', skin:'rgba(255,208,198,.8)',  feat:'rgba(88,0,0,.55)'   },
  { bg1:'#c890ff', bg2:'#7820e0', bg3:'#480090', skin:'rgba(238,210,255,.8)',  feat:'rgba(48,0,88,.55)'  },
];

let _avIdCounter = 0;
function makeAv(idx, size) {
  const t = AV_THEMES[idx % AV_THEMES.length];
  const id = 'av' + (++_avIdCounter);
  const h = size / 2, r = h * 0.935;
  const headR = size * 0.21, eyeY = h * 0.72, eyeOff = h * 0.22, eyeR = size * 0.038;
  const smY = h * 0.92, smR = h * 0.14;
  const bEllX = h * 0.52, bEllY = h * 0.42;
  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="width:${size}px;height:${size}px;display:block;overflow:visible">
    <defs>
      <radialGradient id="bg${id}" cx="38%" cy="28%" r="68%">
        <stop offset="0%" stop-color="${t.bg1}"/><stop offset="55%" stop-color="${t.bg2}"/><stop offset="100%" stop-color="${t.bg3}"/>
      </radialGradient>
      <radialGradient id="sh${id}" cx="36%" cy="22%" r="58%">
        <stop offset="0%" stop-color="rgba(255,255,255,.72)"/><stop offset="55%" stop-color="rgba(255,255,255,.06)"/><stop offset="100%" stop-color="rgba(255,255,255,0)"/>
      </radialGradient>
      <clipPath id="cp${id}"><circle cx="${h}" cy="${h}" r="${r}"/></clipPath>
    </defs>
    <circle cx="${h}" cy="${h}" r="${r}" fill="url(#bg${id})"/>
    <ellipse cx="${h}" cy="${size*.88}" rx="${bEllX}" ry="${bEllY}" fill="${t.skin}" clip-path="url(#cp${id})"/>
    <circle cx="${h}" cy="${h*.72}" r="${headR}" fill="${t.skin}" clip-path="url(#cp${id})"/>
    <circle cx="${h-eyeOff}" cy="${eyeY}" r="${eyeR}" fill="${t.feat}"/>
    <circle cx="${h+eyeOff}" cy="${eyeY}" r="${eyeR}" fill="${t.feat}"/>
    <path d="M ${h-smR} ${smY} Q ${h} ${smY+size*.055} ${h+smR} ${smY}" stroke="${t.feat}" stroke-width="${size*.028}" fill="none" stroke-linecap="round"/>
    <ellipse cx="${h}" cy="${h}" rx="${r*.96}" ry="${r*.96}" fill="url(#sh${id})"/>
    <circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke="rgba(255,255,255,.42)" stroke-width="${size*.022}"/>
  </svg>`;
}

// ── STATE ──────────────────────────────────────────────────────────
let socket      = null;
let me          = { username: '', avatar: 0, avatarUrl: null, status: 'online', mood: '', bio: '' };
let activeChat  = null;   // username for DMs, or null
let activeRoom  = null;   // roomId for group chats, or null
let users       = {};     // username → userObj
let convos      = {};     // username → msg[]
let roomMsgs    = {};     // roomId → msg[]
let rooms       = {};     // roomId → roomObj
let reactions   = {};     // msgId → { emoji: [username] }
let typingTimers= {};
let unread      = {};     // username / roomId → count
let serverAddr  = '';
let serverBase  = '';     // http://host:port — for file URLs
let pendingFile = null;   // { dataUrl?, url?, name, isImage }
let friendList  = [];

const MAX_HISTORY = 500;

// ── DOM HELPERS ────────────────────────────────────────────────────
const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function safeImg(src, cls, alt) {
  const img = document.createElement('img');
  img.src   = src;
  if (cls) img.className = cls;
  if (alt) img.alt = alt;
  return img;
}

// ── API ────────────────────────────────────────────────────────────
const api = {
  join    : (data)              => socket.emit('user:join',      data),
  send    : (to, text, img, fileUrl, fileName) =>
                                   socket.emit('message:send',   { to, text: text||'', image: img||null, fileUrl: fileUrl||null, fileName: fileName||null }),
  roomMsg : (roomId, text, fileUrl, fileName) =>
                                   socket.emit('room:message',   { roomId, text: text||'', fileUrl: fileUrl||null, fileName: fileName||null }),
  edit    : (id, to, text, roomId) => socket.emit('message:edit', { id, to, text, roomId }),
  del     : (id, to, roomId)    => socket.emit('message:delete', { id, to, roomId }),
  react   : (msgId, emoji, to, roomId) => socket.emit('message:react', { msgId, emoji, to, roomId }),
  typStart: (to, roomId)        => socket.emit('typing:start',   { to, roomId }),
  typStop : (to, roomId)        => socket.emit('typing:stop',    { to, roomId }),
  nudge   : (to)                => socket.emit('nudge:send',     { to }),
  status  : (status, mood)      => socket.emit('user:status',    { status, mood }),
  history : (partner)           => socket.emit('history:get',    { with: partner }),
  seen    : (to)                => socket.emit('message:seen',   { to }),
  createRoom : (name, desc)     => socket.emit('room:create',    { name, description: desc }),
  joinRoom   : (roomId)         => socket.emit('room:join',      { roomId }),
  leaveRoom  : (roomId)         => socket.emit('room:leave',     { roomId }),
  roomHistory: (roomId)         => socket.emit('room:history',   { roomId }),
  getProfile : (username)       => socket.emit('profile:get',    { username }),
  updateProfile: (data)         => socket.emit('profile:update', data),
  friendReq  : (to)             => socket.emit('friend:request', { to }),
  friendAccept: (from)          => socket.emit('friend:accept',  { from }),
  friendRemove: (username)      => socket.emit('friend:remove',  { username }),
  friendList : ()               => socket.emit('friend:list'),
};

// ── UTIL ───────────────────────────────────────────────────────────
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\n/g,'<br>');
}
function isEmojiOnly(str) {
  return /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+$/u.test(str.trim());
}
function capConvo(key, store) {
  if (store[key] && store[key].length > MAX_HISTORY)
    store[key] = store[key].slice(-MAX_HISTORY);
}
function resolveFileUrl(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return serverBase + url;
}

// ── SOUNDS (unchanged from v3) ─────────────────────────────────────
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}
let _masterGain = null;
function getMaster() {
  const ctx = getAudioCtx();
  if (!_masterGain) { _masterGain = ctx.createGain(); _masterGain.gain.value = 0.72; _masterGain.connect(ctx.destination); }
  return _masterGain;
}
function osc(ctx, type, freq, startT, endT, startGain, endGain, dest) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, startT);
  g.gain.setValueAtTime(startGain, startT);
  g.gain.exponentialRampToValueAtTime(Math.max(endGain, 0.0001), endT);
  o.connect(g); g.connect(dest); o.start(startT); o.stop(endT + 0.01);
}
function oscFreqRamp(ctx, type, freqStart, freqEnd, startT, endT, sg, eg, dest) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freqStart, startT);
  o.frequency.exponentialRampToValueAtTime(freqEnd, endT);
  g.gain.setValueAtTime(sg, startT); g.gain.exponentialRampToValueAtTime(Math.max(eg,0.0001), endT);
  o.connect(g); g.connect(dest); o.start(startT); o.stop(endT + 0.02);
}
function withTail(ctx, dest, dg=0.85, tg=0.15, td=0.08) {
  const dry=ctx.createGain(), delay=ctx.createDelay(0.5), tail=ctx.createGain();
  dry.gain.value=dg; tail.gain.value=tg; delay.delayTime.value=td;
  dry.connect(dest); dry.connect(delay); delay.connect(tail); tail.connect(dest);
  return dry;
}
function playReceiveBlip() { try { const ctx=getAudioCtx(),t=ctx.currentTime+0.01,out=withTail(ctx,getMaster(),.82,.18,.09); oscFreqRamp(ctx,'sine',1047,1050,t,t+.04,.28,.20,out); oscFreqRamp(ctx,'sine',2093,2100,t,t+.04,.10,.06,out); osc(ctx,'sine',523,t,t+.28,.08,.001,out); const t2=t+.12; oscFreqRamp(ctx,'sine',1318,1320,t2,t2+.03,.22,.16,out); oscFreqRamp(ctx,'sine',2637,2640,t2,t2+.03,.08,.04,out); osc(ctx,'sine',659,t2,t2+.30,.06,.001,out); } catch(_){} }
function playSendBlip()    { try { const ctx=getAudioCtx(),t=ctx.currentTime+.01,out=getMaster(); oscFreqRamp(ctx,'sine',800,420,t,t+.055,.22,.001,out); oscFreqRamp(ctx,'sine',600,560,t+.04,t+.13,.10,.001,out); oscFreqRamp(ctx,'sine',2400,1800,t,t+.04,.04,.001,out); } catch(_){} }
function playOnlineSound() { try { const ctx=getAudioCtx(),t=ctx.currentTime+.01,out=withTail(ctx,getMaster(),.80,.20,.12); [587,740,880].forEach((freq,i)=>{const nt=t+i*.11; oscFreqRamp(ctx,'sine',freq,freq*1.003,nt,nt+.03,.20,.14,out); osc(ctx,'sine',freq*.5,nt,nt+.22,.06,.001,out); osc(ctx,'sine',freq*2,nt,nt+.10,.04,.001,out);}); } catch(_){} }
function playOfflineSound(){ try { const ctx=getAudioCtx(),t=ctx.currentTime+.01,out=withTail(ctx,getMaster(),.85,.15,.10); [440,330].forEach((freq,i)=>{const nt=t+i*.13; oscFreqRamp(ctx,'sine',freq*1.002,freq,nt,nt+.04,.18,.12,out); osc(ctx,'sine',freq*.5,nt,nt+.25,.05,.001,out);}); } catch(_){} }
function playNudgeSound()  { try { const ctx=getAudioCtx(),out=withTail(ctx,getMaster(),.75,.25,.06); [0,.09,.18,.27].forEach((delay,i)=>{const t=ctx.currentTime+.01+delay,freq=i%2===0?520:490; oscFreqRamp(ctx,'sawtooth',freq,freq*.92,t,t+.07,.18,.001,out); oscFreqRamp(ctx,'sine',freq*1.5,freq*1.4,t,t+.07,.12,.001,out); osc(ctx,'sine',1200-i*80,t,t+.05,.08,.001,out);}); } catch(_){} }
function playTypingSound() { try { const ctx=getAudioCtx(),t=ctx.currentTime+.01,out=getMaster(); oscFreqRamp(ctx,'sine',380,340,t,t+.08,.07,.001,out); oscFreqRamp(ctx,'sine',760,680,t,t+.06,.03,.001,out); } catch(_){} }
function playConnectSound(){ try { const ctx=getAudioCtx(),t=ctx.currentTime+.01,out=withTail(ctx,getMaster(),.78,.22,.14); oscFreqRamp(ctx,'sine',659,662,t,t+.04,.22,.16,out); osc(ctx,'sine',330,t,t+.35,.08,.001,out); osc(ctx,'sine',1320,t,t+.15,.05,.001,out); const t2=t+.18; oscFreqRamp(ctx,'sine',784,786,t2,t2+.04,.20,.14,out); osc(ctx,'sine',392,t2,t2+.40,.07,.001,out); osc(ctx,'sine',1568,t2,t2+.18,.04,.001,out); } catch(_){} }
function playDisconnectSound(){try{const ctx=getAudioCtx(),t=ctx.currentTime+.01,out=getMaster(); oscFreqRamp(ctx,'sine',280,160,t,t+.30,.18,.001,out); oscFreqRamp(ctx,'sine',200,130,t+.05,t+.30,.08,.001,out);}catch(_){}}
function playErrorSound()  { try { const ctx=getAudioCtx(),t=ctx.currentTime+.01,out=getMaster(); oscFreqRamp(ctx,'square',200,120,t,t+.12,.12,.001,out); oscFreqRamp(ctx,'sine',180,100,t,t+.18,.10,.001,out); } catch(_){} }
function playLoginSound()  { try { const ctx=getAudioCtx(),t=ctx.currentTime+.01,out=withTail(ctx,getMaster(),.82,.18,.10); oscFreqRamp(ctx,'sine',440,1047,t,t+.12,.14,.001,out); oscFreqRamp(ctx,'sine',880,2093,t+.04,t+.14,.06,.001,out); } catch(_){} }
function playReactionSound(){ try { const ctx=getAudioCtx(),t=ctx.currentTime+.01,out=getMaster(); oscFreqRamp(ctx,'sine',1760,1764,t,t+.025,.14,.08,out); osc(ctx,'sine',3520,t,t+.08,.05,.001,out); oscFreqRamp(ctx,'sine',1760,1800,t+.04,t+.12,.06,.001,out); } catch(_){} }
function playPopSound()    { try { const ctx=getAudioCtx(),t=ctx.currentTime+.01,out=getMaster(); oscFreqRamp(ctx,'sine',600,900,t,t+.04,.10,.001,out); oscFreqRamp(ctx,'sine',900,1200,t+.02,t+.07,.05,.001,out); } catch(_){} }
function playImageSound()  { try { const ctx=getAudioCtx(),t=ctx.currentTime+.01,out=getMaster(); oscFreqRamp(ctx,'square',3200,800,t,t+.025,.15,.001,out); oscFreqRamp(ctx,'sine',400,200,t+.03,t+.10,.08,.001,out); } catch(_){} }

// ── ICON STATE ─────────────────────────────────────────────────────
const iconState = (() => {
  let _hasUnread = false;
  function update() {
    const total = Object.values(unread).reduce((a,b)=>a+b, 0);
    const shouldBeUnread = total > 0;
    if (shouldBeUnread === _hasUnread) return;
    _hasUnread = shouldBeUnread;
    if (window.talkity) window.talkity.setIcon(_hasUnread ? 'unread' : 'normal');
    document.title = _hasUnread ? `(${total}) Talkity` : 'Talkity';
  }
  return { update };
})();

// ── TOAST ──────────────────────────────────────────────────────────
let _toastTimeout;
function showToast(fromUser, text) {
  const old = $('liveToast'); if (old) old.remove();
  clearTimeout(_toastTimeout);
  const u = users[fromUser] || { avatar: 0 };
  const toast = document.createElement('div');
  toast.className = 'toast'; toast.id = 'liveToast';
  const avEl = document.createElement('div');
  avEl.className = 'toast-av';
  avEl.innerHTML = makeAv(u.avatar||0, 30);
  const body = document.createElement('div'); body.className = 'toast-body';
  const nameEl = document.createElement('div'); nameEl.className = 'toast-name'; nameEl.textContent = fromUser;
  const msgEl  = document.createElement('div'); msgEl.className  = 'toast-msg';  msgEl.textContent  = text;
  body.append(nameEl, msgEl); toast.append(avEl, body);
  toast.addEventListener('click', () => { openChat(fromUser); toast.remove(); });
  document.body.appendChild(toast);
  _toastTimeout = setTimeout(() => toast.remove(), 4500);
}

// ── AVATAR PICKER ─────────────────────────────────────────────────
function buildAvatarPicker() {
  const wrap = $('avatarPicker'); wrap.innerHTML = '';
  AV_THEMES.forEach((_, i) => {
    const el = document.createElement('div');
    el.className = 'av-pick-item' + (i === 0 ? ' selected' : '');
    el.innerHTML = makeAv(i, 38); el.dataset.idx = i;
    el.addEventListener('click', () => {
      $$('.av-pick-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected'); me.avatar = i;
    });
    wrap.appendChild(el);
  });
}

// ── THEME TOGGLE ───────────────────────────────────────────────────
let darkMode = false;
function applyTheme() {
  document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  const btn = $('themeToggleBtn');
  if (btn) btn.textContent = darkMode ? '☀️' : '🌙';
}

// ── LOGIN ──────────────────────────────────────────────────────────
function attemptLogin() {
  const username = $('loginUsername').value.trim();
  const addr     = $('loginServer').value.trim() || 'localhost:3747';
  const errEl    = $('loginError');
  errEl.textContent = '';
  if (!username)           { errEl.textContent = 'Please enter a display name!'; return; }
  if (username.length < 2) { errEl.textContent = 'Name must be at least 2 characters'; return; }

  const btn = $('loginBtn'), btnText = btn.querySelector('.login-btn-text');
  btnText.textContent = 'Connecting...'; btn.disabled = true;
  playLoginSound();

  serverAddr = addr;
  serverBase = addr.startsWith('http') ? addr : `http://${addr}`;

  const url = addr.startsWith('http') ? addr : `http://${addr}`;
  const socketOpts = {
    timeout: 10000, reconnection: true, reconnectionDelay: 2000,
    reconnectionAttempts: 5, transports: ['polling', 'websocket'],
    extraHeaders: { 'ngrok-skip-browser-warning': 'true' },
  };

  try { socket = io(url, socketOpts); }
  catch (e) {
    errEl.textContent = 'Could not connect: ' + e.message;
    btnText.textContent = 'Sign in to Talkity →'; btn.disabled = false; return;
  }

  socket.on('connect', () => {
    me.username = username;
    api.join({ username: me.username, avatar: me.avatar, status: me.status, mood: me.mood });
  });

  socket.on('user:joined', () => {
    $('loginScreen').classList.add('hidden');
    $('appScreen').classList.remove('hidden');
    $('connDot').classList.add('connected');
    $('connDot').title = 'Connected to ' + serverAddr;
    playConnectSound();
    initApp();
  });

  socket.on('connect_error', (err) => {
    const isNgrok = addr.includes('ngrok');
    errEl.textContent = isNgrok
      ? `ngrok tunnel error — is the server running?`
      : `Can't reach server at ${addr} — is it running?`;
    btnText.textContent = 'Sign in to Talkity →'; btn.disabled = false;
    playErrorSound(); socket.disconnect();
  });

  setupSocketListeners();
}

// ── SOCKET LISTENERS ──────────────────────────────────────────────
function setupSocketListeners() {

  socket.on('users:list', (list) => {
    const prev = { ...users };
    users = {};
    list.forEach(u => { if (u.username !== me.username) users[u.username] = u; });
    Object.keys(users).forEach(name => { if (!prev[name]) { showToast(name, '🟢 Just came online!'); playOnlineSound(); } });
    Object.keys(prev).forEach(name => { if (!users[name]) playOfflineSound(); });
    Object.keys(typingTimers).forEach(name => {
      if (!users[name]) { clearTimeout(typingTimers[name]); delete typingTimers[name]; if (activeChat===name) $('typingRow').classList.add('hidden'); }
    });
    renderContacts(); renderRoomsList();
    if (activeChat) updateChatHeader();
  });

  // ── DM received ──
  socket.on('message:receive', (msg) => {
    if (!convos[msg.from]) convos[msg.from] = [];
    msg.reactions = msg.reactions || {};
    if (msg.reactions && typeof msg.reactions === 'object' && !Array.isArray(msg.reactions)) {
      reactions[msg.id] = msg.reactions;
    }
    convos[msg.from].push(msg); capConvo(msg.from, convos);
    if (activeChat === msg.from) { appendMsgToDOM(msg, false); api.seen(msg.from); playReceiveBlip(); }
    else { unread[msg.from] = (unread[msg.from]||0)+1; showToast(msg.from, msg.fileUrl ? '📎 Sent a file' : msg.image ? '📷 Sent an image' : msg.text); playReceiveBlip(); if (window.talkity) window.talkity.notify(msg.from, msg.fileUrl ? '📎 File' : msg.image ? '📷 Image' : msg.text); }
    if (msg.image) playImageSound();
    iconState.update(); renderContacts();
  });

  // ── Room message received ──
  socket.on('room:message', (msg) => {
    if (!roomMsgs[msg.roomId]) roomMsgs[msg.roomId] = [];
    msg.reactions = msg.reactions || {};
    if (msg.reactions && typeof msg.reactions === 'object') reactions[msg.id] = msg.reactions;
    roomMsgs[msg.roomId].push(msg); capConvo(msg.roomId, roomMsgs);
    if (activeRoom === msg.roomId) { appendMsgToDOM(msg, true); playReceiveBlip(); }
    else { unread[msg.roomId] = (unread[msg.roomId]||0)+1; playReceiveBlip(); if (window.talkity) window.talkity.notify('#'+rooms[msg.roomId]?.name, msg.text||'File'); }
    iconState.update(); renderRoomsList();
  });

  socket.on('message:sent', () => {});

  socket.on('message:edited', ({ id, from, text }) => {
    const partner = from === me.username ? activeChat : from;
    if (partner && convos[partner]) { const m = convos[partner].find(m=>m.id===id); if (m) { m.text=text; m.edited=true; } }
    // also check room messages
    Object.keys(roomMsgs).forEach(rid => {
      const m = (roomMsgs[rid]||[]).find(m=>m.id===id);
      if (m) { m.text=text; m.edited=true; if (activeRoom===rid) renderMessages(); }
    });
    if (activeChat === partner) renderMessages();
  });

  socket.on('message:deleted', ({ id, from }) => {
    const partner = from === me.username ? activeChat : from;
    if (partner && convos[partner]) convos[partner] = convos[partner].filter(m=>m.id!==id);
    Object.keys(roomMsgs).forEach(rid => {
      if (roomMsgs[rid]) { roomMsgs[rid] = roomMsgs[rid].filter(m=>m.id!==id); if (activeRoom===rid) renderMessages(); }
    });
    if (activeChat === partner) renderMessages();
  });

  socket.on('message:react', ({ msgId, emoji, from, removed }) => {
    if (!reactions[msgId]) reactions[msgId] = {};
    if (!reactions[msgId][emoji]) reactions[msgId][emoji] = [];
    if (removed) {
      reactions[msgId][emoji] = reactions[msgId][emoji].filter(u=>u!==from);
    } else {
      if (!reactions[msgId][emoji].includes(from)) reactions[msgId][emoji].push(from);
    }
    if (reactions[msgId][emoji].length === 0) delete reactions[msgId][emoji];
    if (activeChat || activeRoom) renderMessages();
  });

  socket.on('typing:start', ({ from, roomId }) => {
    if (roomId) { if (activeRoom!==roomId) return; }
    else { if (activeChat!==from) return; }
    const wasHidden = $('typingRow').classList.contains('hidden');
    $('typingRow').classList.remove('hidden');
    if (wasHidden) playTypingSound();
    scrollToBottom();
    clearTimeout(typingTimers[from]);
    typingTimers[from] = setTimeout(() => $('typingRow').classList.add('hidden'), 4000);
  });

  socket.on('typing:stop', ({ from }) => {
    if (activeChat !== from && activeRoom) return;
    clearTimeout(typingTimers[from]);
    $('typingRow').classList.add('hidden');
  });

  socket.on('nudge:receive', ({ from }) => {
    if (activeChat === from) triggerNudge();
    playNudgeSound(); showToast(from, '💫 sent you a Nudge!');
  });

  // DM history
  socket.on('history:data', ({ with: partner, messages: msgs }) => {
    convos[partner] = msgs.map(m => {
      if (m.reactions) { reactions[m.id] = m.reactions; }
      return m;
    });
    capConvo(partner, convos);
    if (activeChat === partner) renderMessages();
  });

  // Room history
  socket.on('room:history', ({ roomId, messages: msgs }) => {
    roomMsgs[roomId] = msgs.map(m => {
      if (m.reactions) { reactions[m.id] = m.reactions; }
      return m;
    });
    capConvo(roomId, roomMsgs);
    if (activeRoom === roomId) renderMessages();
  });

  socket.on('message:seen', ({ from }) => {
    if (!convos[from]) return;
    convos[from].forEach(m => { if (m.from === me.username) m.seen = true; });
    if (activeChat === from) updateSeenTicks();
  });

  // Rooms
  socket.on('rooms:list', (list) => {
    list.forEach(r => { rooms[r.id] = r; });
    renderRoomsList();
  });
  socket.on('room:created', (room) => { rooms[room.id] = room; renderRoomsList(); });
  socket.on('room:joined',  ({ roomId, name }) => { if (rooms[roomId]) rooms[roomId].joined = true; renderRoomsList(); });
  socket.on('room:left',    ({ roomId }) => { if (rooms[roomId]) rooms[roomId].joined = false; renderRoomsList(); });
  socket.on('room:member_joined', () => {});
  socket.on('room:member_left',   () => {});

  // Friends
  socket.on('friend:request', ({ from }) => { showToast(from, '🤝 wants to be your friend!'); renderFriendsPanel(); });
  socket.on('friend:accepted', ({ by }) => { showToast(by, '🤝 accepted your friend request!'); api.friendList(); });
  socket.on('friend:list', (list) => { friendList = list; renderFriendsPanel(); });
  socket.on('friend:request_sent', () => {});
  socket.on('friend:removed', () => { api.friendList(); });

  // Profile
  socket.on('profile:data', (data) => { if (data) showProfileCard(data); });

  socket.on('disconnect', () => {
    $('connDot').classList.remove('connected'); $('connDot').title = 'Disconnected'; playDisconnectSound();
    Object.keys(typingTimers).forEach(k => clearTimeout(typingTimers[k]));
    typingTimers = {}; $('typingRow').classList.add('hidden');
  });

  socket.on('reconnect', () => {
    $('connDot').classList.add('connected'); playConnectSound();
    api.join({ username: me.username, avatar: me.avatar, status: me.status, mood: me.mood });
  });
}

// ── READ RECEIPT TICKS ──────────────────────────────────────────────
function updateSeenTicks() {
  document.querySelectorAll('.msg-row.mine').forEach(row => {
    const id = row.dataset.msgId;
    const msg = (convos[activeChat]||[]).find(m=>m.id===id);
    if (!msg) return;
    let tick = row.querySelector('.read-tick');
    if (!tick) { tick = document.createElement('div'); tick.className = 'read-tick'; row.appendChild(tick); }
    tick.textContent = msg.seen ? '✓✓' : '✓';
    tick.classList.toggle('seen', !!msg.seen);
  });
}

// ── INIT APP ────────────────────────────────────────────────────────
function initApp() {
  $('myName').textContent = me.username;
  const avWrap = $('myAvWrap');
  avWrap.innerHTML = makeAv(me.avatar, 44) + `<div class="sdot online" style="border-color:rgba(18,80,172,.6);"></div>`;
  avWrap.style.cssText = 'position:relative;filter:drop-shadow(0 3px 7px rgba(0,0,50,.38));flex-shrink:0;';

  const moodEl = $('myMood');
  moodEl.addEventListener('blur', () => { me.mood = moodEl.textContent.trim(); api.status(me.status, me.mood); });
  moodEl.addEventListener('keydown', e => { if (e.key==='Enter') { e.preventDefault(); moodEl.blur(); } });

  $('modalServerBox').textContent = 'Server: ' + serverAddr + '  —  share this with friends!';
  $('serverInfoBtn').addEventListener('click', () => $('serverModal').classList.remove('hidden'));
  $('modalCloseBtn').addEventListener('click', () => $('serverModal').classList.add('hidden'));

  $('signOutBtn').addEventListener('click', () => { playDisconnectSound(); setTimeout(() => { socket.disconnect(); location.reload(); }, 200); });

  $('myStatusBtn').addEventListener('click', e => { e.stopPropagation(); $('statusMenu').classList.toggle('hidden'); });
  $$('.sm-item').forEach(el => {
    el.addEventListener('click', () => {
      me.status = el.dataset.status;
      const icons = { online:'🟢', away:'🟡', busy:'🔴', invisible:'⚫' };
      $('myStatusBtn').textContent = icons[me.status];
      api.status(me.status, me.mood);
      $('statusMenu').classList.add('hidden');
      const dot = document.querySelector('#myAvWrap .sdot');
      if (dot) dot.className = 'sdot ' + me.status;
    });
  });
  document.addEventListener('click', () => $('statusMenu').classList.add('hidden'));

  $('sbSearch').addEventListener('input', e => renderContacts(e.target.value));

  $('nudgeBtn').addEventListener('click', () => { if (!activeChat) return; api.nudge(activeChat); triggerNudge(); playNudgeSound(); });

  buildEmojiTray();
  $('emojiToggle').addEventListener('click', e => { e.stopPropagation(); const was=$('emojiTray').classList.contains('hidden'); $('emojiTray').classList.toggle('hidden'); if(was) playPopSound(); });
  document.addEventListener('click', e => { if (!e.target.closest('#emojiTray') && !e.target.closest('#emojiToggle')) $('emojiTray').classList.add('hidden'); });

  $$('.it-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const action = btn.dataset.action, ta = $('msgInput');
      if (action==='bold')   wrapSelection(ta,'**','**');
      if (action==='italic') wrapSelection(ta,'_','_');
      if (action==='nudge' && activeChat) { api.nudge(activeChat); triggerNudge(); playNudgeSound(); }
      ta.focus();
    });
  });

  // File attach (replaces old image-only attach)
  $('imgAttachBtn').addEventListener('click', () => $('imgFileInput').click());
  $('imgFileInput').addEventListener('change', handleFileSelected);

  $('sendBtn').addEventListener('click', sendMessage);
  $('msgInput').addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

  const ta = $('msgInput');
  ta.addEventListener('input', () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,100)+'px'; });

  let typingSent = false, typingStop;
  ta.addEventListener('input', () => {
    const target = activeChat || activeRoom;
    if (!target) return;
    if (!typingSent) { api.typStart(activeChat, activeRoom); typingSent = true; }
    clearTimeout(typingStop);
    typingStop = setTimeout(() => { api.typStop(activeChat, activeRoom); typingSent = false; }, 1500);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const lb = document.querySelector('.lightbox'); if (lb) { lb.remove(); return; }
      $('emojiTray').classList.add('hidden');
      document.querySelector('.profile-card-overlay')?.remove();
      document.querySelector('.create-room-modal')?.remove();
    }
  });

  if (window.talkity) {
    $('winMin').addEventListener('click',   () => window.talkity.minimize());
    $('winMax').addEventListener('click',   () => window.talkity.maximize());
    $('winClose').addEventListener('click', () => window.talkity.close());
  }

  // Theme toggle
  const themeBtn = $('themeToggleBtn');
  if (themeBtn) themeBtn.addEventListener('click', () => { darkMode = !darkMode; applyTheme(); });

  // Friends panel toggle
  const friendsBtn = $('friendsBtn');
  if (friendsBtn) { friendsBtn.addEventListener('click', () => { toggleFriendsPanel(); api.friendList(); }); }

  // Rooms panel: create room button
  const createRoomBtn = $('createRoomBtn');
  if (createRoomBtn) createRoomBtn.addEventListener('click', showCreateRoomModal);

  api.friendList();
  applyTheme();
}

// ── FILE HANDLING ──────────────────────────────────────────────────
async function handleFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { alert('File must be under 20 MB'); return; }

  const isImage = file.type.startsWith('image/');

  if (isImage && file.size < 2 * 1024 * 1024) {
    // Small images: send as base64 (backward compat)
    const reader = new FileReader();
    reader.onload = ev => {
      pendingFile = { dataUrl: ev.target.result, name: file.name, isImage: true };
      showFilePreview();
    };
    reader.readAsDataURL(file);
  } else {
    // Upload to server
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(serverBase + '/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.error) { alert('Upload failed: ' + data.error); return; }
      pendingFile = { url: resolveFileUrl(data.url), name: data.name, isImage, serverPath: data.url };
      showFilePreview();
    } catch (err) {
      alert('Upload failed — is the server running?');
    }
  }
  e.target.value = '';
}

function showFilePreview() {
  let row = $('imgPreviewRow');
  if (!row) { row = document.createElement('div'); row.id='imgPreviewRow'; row.className='img-preview-row'; $('inputZoneInner').prepend(row); }
  row.innerHTML = '';

  if (pendingFile.isImage && pendingFile.dataUrl) {
    const thumb = safeImg(pendingFile.dataUrl, 'img-preview-thumb', 'preview');
    row.appendChild(thumb);
  } else {
    const icon = document.createElement('div'); icon.className='img-preview-thumb file-icon'; icon.textContent='📎'; row.appendChild(icon);
  }
  const name = document.createElement('div'); name.className='img-preview-name'; name.textContent=(pendingFile.isImage?'📷 ':'📎 ')+pendingFile.name;
  const clear = document.createElement('div'); clear.className='img-preview-clear'; clear.id='imgPreviewClear'; clear.textContent='✕';
  clear.addEventListener('click', clearFilePreview);
  row.append(name, clear);
}

function clearFilePreview() { pendingFile = null; const row=$('imgPreviewRow'); if(row) row.remove(); }

function openLightbox(src) {
  const lb = document.createElement('div'); lb.className = 'lightbox';
  const img = safeImg(src, null, 'image');
  const closeBtn = document.createElement('div'); closeBtn.className='lightbox-close'; closeBtn.textContent='✕';
  closeBtn.addEventListener('click', () => lb.remove());
  lb.append(img, closeBtn);
  lb.addEventListener('click', e => { if (e.target===lb) lb.remove(); });
  document.body.appendChild(lb);
}

// ── EMOJI TRAY ──────────────────────────────────────────────────────
const EMOJIS = ['😊','😂','😭','😍','🥺','😎','🤣','😅','👍','❤️','💙','✨','🎉','🔥','😏','🙈','💀','🥰','😤','🌟','🦋','💕','🎵','👀','😩','🤩','💯','🫶','🫠','😱','🙃','😔','🤦','🎮','🍕','🌈','⭐','🥳','😴','💤'];
function buildEmojiTray() {
  const tray = $('emojiTray'); tray.innerHTML = '';
  EMOJIS.forEach(e => {
    const b = document.createElement('button'); b.className='et-btn'; b.textContent=e;
    b.addEventListener('click', ev => { ev.stopPropagation(); const ta=$('msgInput'); ta.value+=e; ta.focus(); });
    tray.appendChild(b);
  });
}

// ── REACTION PICKER ────────────────────────────────────────────────
const REACTION_SET = ['👍','❤️','😂','😮','😢','🔥','🎉','💯'];
function buildReactionPicker(msg, anchorEl) {
  document.querySelector('.reaction-picker')?.remove();
  const picker = document.createElement('div'); picker.className='reaction-picker';
  REACTION_SET.forEach(emoji => {
    const btn = document.createElement('button'); btn.className='rp-btn'; btn.textContent=emoji;
    btn.addEventListener('click', e => { e.stopPropagation(); toggleReaction(msg.id, emoji, msg); picker.remove(); });
    picker.appendChild(btn);
  });
  anchorEl.appendChild(picker);
  const close = e => { if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 10);
}

function toggleReaction(msgId, emoji, msg) {
  if (!reactions[msgId]) reactions[msgId] = {};
  if (!reactions[msgId][emoji]) reactions[msgId][emoji] = [];
  const arr = reactions[msgId][emoji];
  const idx = arr.indexOf(me.username);
  if (idx >= 0) arr.splice(idx, 1); else arr.push(me.username);
  if (arr.length === 0) delete reactions[msgId][emoji];
  playReactionSound();
  const to     = msg?.to     || msg?.from;
  const roomId = msg?.roomId || null;
  const partner = (to === me.username) ? msg.from : to;
  api.react(msgId, emoji, roomId ? null : partner, roomId || null);
  renderMessages();
}

// ── ROOMS PANEL ────────────────────────────────────────────────────
function renderRoomsList() {
  const list = $('roomsList');
  if (!list) return;
  list.innerHTML = '';
  const roomArr = Object.values(rooms);
  if (roomArr.length === 0) {
    const empty = document.createElement('div'); empty.className='no-friends';
    empty.style.fontSize='10px'; empty.textContent='No rooms yet — create one!';
    list.appendChild(empty); return;
  }
  roomArr.forEach(room => {
    const el = document.createElement('div');
    el.className = 'contact-item room-item' + (activeRoom===room.id ? ' active' : '');
    const badge = unread[room.id];
    const nameDiv = document.createElement('div'); nameDiv.className='ci-name'; nameDiv.textContent='# '+room.name;
    const descDiv = document.createElement('div'); descDiv.className='ci-preview'; descDiv.textContent=room.description||'Group chat';
    const info = document.createElement('div'); info.className='ci-info'; info.append(nameDiv, descDiv);
    const meta = document.createElement('div'); meta.className='ci-meta';
    if (badge) { const b=document.createElement('div'); b.className='ci-badge'; b.textContent=badge; meta.appendChild(b); }
    el.append(info, meta);
    el.addEventListener('click', () => openRoomChat(room.id));
    list.appendChild(el);
  });
}

function openRoomChat(roomId) {
  activeChat = null; activeRoom = roomId;
  unread[roomId] = 0; iconState.update();
  $('chatEmpty').classList.add('hidden');
  $('chatPanel').classList.remove('hidden');
  $('typingRow').classList.add('hidden');
  // Update header to show room name
  const room = rooms[roomId] || {};
  $('chName').textContent = '# ' + (room.name || roomId);
  $('chStatus').textContent = room.description || 'Group chat';
  $('chAv').innerHTML = '<div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#78d8ff,#1888d8);display:flex;align-items:center;justify-content:center;font-size:20px;">🏠</div>';
  $('nudgeBtn').style.display = 'none';

  // Join room and request history
  api.joinRoom(roomId);
  if (roomMsgs[roomId]) renderMessages();
  api.roomHistory(roomId);
  renderContacts(); renderRoomsList();
  $('msgInput').focus();
}

function showCreateRoomModal() {
  document.querySelector('.create-room-modal')?.remove();
  const overlay = document.createElement('div'); overlay.className='modal-overlay create-room-modal';
  const card = document.createElement('div'); card.className='modal-card';
  card.innerHTML = `
    <div class="modal-shine"></div>
    <div class="modal-title">🏠 Create a Room</div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:16px;">
      <div class="login-field-group">
        <label class="lf-label">Room name</label>
        <input id="newRoomName" class="lf-input" placeholder="e.g. general, gaming, music" maxlength="32">
      </div>
      <div class="login-field-group">
        <label class="lf-label">Description (optional)</label>
        <input id="newRoomDesc" class="lf-input" placeholder="What's this room for?" maxlength="80">
      </div>
    </div>
    <div style="display:flex;gap:8px;">
      <button id="createRoomConfirm" class="login-btn" style="flex:1;margin:0;padding:10px;">
        <span class="login-btn-shine"></span><span class="login-btn-text">Create Room</span>
      </button>
      <button id="createRoomCancel" class="modal-close-btn" style="margin:0;flex:0.5;padding:10px;">Cancel</button>
    </div>`;
  overlay.appendChild(card);
  overlay.addEventListener('click', e => { if (e.target===overlay) overlay.remove(); });
  card.querySelector('#createRoomConfirm').addEventListener('click', () => {
    const name = card.querySelector('#newRoomName').value.trim();
    if (!name) return;
    api.createRoom(name, card.querySelector('#newRoomDesc').value.trim());
    overlay.remove();
  });
  card.querySelector('#createRoomCancel').addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
  setTimeout(() => card.querySelector('#newRoomName')?.focus(), 50);
}

// ── FRIENDS PANEL ─────────────────────────────────────────────────
function toggleFriendsPanel() {
  const panel = $('friendsPanel');
  if (!panel) return;
  panel.classList.toggle('hidden');
}

function renderFriendsPanel() {
  const list = $('friendsList');
  if (!list) return;
  list.innerHTML = '';
  if (!friendList.length) {
    const empty = document.createElement('div'); empty.style.cssText='padding:10px;font-size:10px;color:rgba(80,130,200,.6);text-align:center;';
    empty.textContent = 'No friends yet. Add someone!'; list.appendChild(empty); return;
  }
  friendList.forEach(f => {
    const isMe = f.requester === me.username;
    const partner = isMe ? f.addressee : f.requester;
    const el = document.createElement('div'); el.style.cssText='display:flex;align-items:center;gap:8px;padding:7px 10px;';
    const nameEl = document.createElement('div'); nameEl.style.cssText='flex:1;font-size:11px;font-weight:800;color:white;';
    nameEl.textContent = partner;
    el.appendChild(nameEl);
    if (f.status === 'pending' && !isMe) {
      const acceptBtn = document.createElement('div');
      acceptBtn.style.cssText='cursor:pointer;font-size:10px;font-weight:800;color:#28ff80;padding:3px 8px;border:1px solid rgba(40,255,120,.3);border-radius:8px;';
      acceptBtn.textContent = '✓ Accept';
      acceptBtn.addEventListener('click', () => { api.friendAccept(partner); api.friendList(); });
      el.appendChild(acceptBtn);
    } else if (f.status === 'accepted') {
      const openBtn = document.createElement('div');
      openBtn.style.cssText='cursor:pointer;font-size:10px;color:rgba(160,210,255,.7);padding:2px 6px;';
      openBtn.textContent = '💬';
      openBtn.addEventListener('click', () => { openChat(partner); toggleFriendsPanel(); });
      el.appendChild(openBtn);
      const removeBtn = document.createElement('div');
      removeBtn.style.cssText='cursor:pointer;font-size:10px;color:rgba(255,120,120,.6);padding:2px 6px;';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => { api.friendRemove(partner); });
      el.appendChild(removeBtn);
    } else {
      const pendingEl = document.createElement('div');
      pendingEl.style.cssText='font-size:9px;color:rgba(255,200,80,.7);';
      pendingEl.textContent = 'pending…'; el.appendChild(pendingEl);
    }
    list.appendChild(el);
  });
}

// ── PROFILE CARD ───────────────────────────────────────────────────
function showProfileCard(data) {
  document.querySelector('.profile-card-overlay')?.remove();
  const overlay = document.createElement('div'); overlay.className='modal-overlay profile-card-overlay';
  const card = document.createElement('div'); card.className='modal-card'; card.style.width='320px';
  const avHtml = data.avatar_url ? `<img src="${data.avatar_url}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;">` : makeAv(data.avatar||0, 64);
  const statusIcons = { online:'🟢', away:'🟡', busy:'🔴', invisible:'⚫', offline:'⚫' };

  card.innerHTML = `
    <div class="modal-shine"></div>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;">
      <div style="filter:drop-shadow(0 3px 8px rgba(0,0,0,.25));">${avHtml}</div>
      <div>
        <div style="font-size:18px;font-weight:900;color:#083870;">${escHtml(data.username)}</div>
        <div style="font-size:12px;color:#2868b0;font-weight:700;margin-top:3px;">${statusIcons[data.status]||'⚫'} ${data.status}</div>
        ${data.mood ? `<div style="font-size:11px;color:#4878b8;font-style:italic;margin-top:2px;">"${escHtml(data.mood)}"</div>` : ''}
      </div>
    </div>
    ${data.bio ? `<div style="font-size:12px;color:#1a3a70;padding:10px;background:rgba(100,180,255,.1);border-radius:10px;border:1px solid rgba(100,170,255,.2);margin-bottom:14px;">${escHtml(data.bio)}</div>` : ''}
    <div style="display:flex;gap:8px;">
      <button id="pcChat" class="login-btn" style="flex:1;margin:0;padding:10px;font-size:12px;">
        <span class="login-btn-shine"></span><span class="login-btn-text">💬 Message</span>
      </button>
      <button id="pcAddFriend" class="login-btn" style="flex:1;margin:0;padding:10px;font-size:12px;background:linear-gradient(180deg,#90f090 0%,#28c840 50%,#108020 100%);">
        <span class="login-btn-shine"></span><span class="login-btn-text">🤝 Add Friend</span>
      </button>
    </div>
    <button class="modal-close-btn" style="margin-top:10px;">Close</button>`;

  overlay.appendChild(card);
  overlay.addEventListener('click', e => { if (e.target===overlay) overlay.remove(); });
  card.querySelector('.modal-close-btn').addEventListener('click', () => overlay.remove());
  card.querySelector('#pcChat').addEventListener('click', () => { openChat(data.username); overlay.remove(); });
  card.querySelector('#pcAddFriend').addEventListener('click', () => { api.friendReq(data.username); overlay.remove(); showToast(data.username, 'Friend request sent!'); });
  document.body.appendChild(overlay);
}

// ── RENDER CONTACTS ────────────────────────────────────────────────
function renderContacts(filter = '') {
  const list = $('contactsList');
  const fl   = filter.toLowerCase();
  const visible = Object.values(users).filter(u => u.username.toLowerCase().includes(fl));

  if (visible.length === 0) {
    list.innerHTML = '';
    const msg = document.createElement('div'); msg.className='no-friends';
    if (!filter) msg.innerHTML = '<div style="font-size:32px;margin-bottom:8px">🌐</div><div>Waiting for friends...</div><div style="font-size:10px;opacity:.6;margin-top:4px">Share your server address!</div>';
    else msg.textContent = '🔍 No results';
    list.appendChild(msg); return;
  }

  list.innerHTML = '';
  visible.sort((a, b) => {
    const order = { online:0, away:1, busy:2, invisible:3, offline:4 };
    const ao = order[a.status]??5, bo = order[b.status]??5;
    if (ao !== bo) return ao - bo;
    return a.username.localeCompare(b.username);
  });

  const onlineCount = visible.filter(u => ['online','away','busy'].includes(u.status)).length;
  $('onlineLabel').textContent = `Online (${onlineCount})`;

  visible.forEach(u => {
    const msgs = convos[u.username]||[];
    const lastMsg = msgs.length ? msgs[msgs.length-1] : null;
    const preview = lastMsg ? (lastMsg.fileUrl ? '📎 File' : lastMsg.image ? '📷 Image' : lastMsg.text) : (u.mood||'...');
    const timeStr = lastMsg ? fmtTime(lastMsg.time) : '';
    const badge = unread[u.username];

    const el = document.createElement('div');
    el.className = 'contact-item' + (u.username===activeChat ? ' active' : '');

    const avDiv = document.createElement('div'); avDiv.className='ci-av';
    avDiv.style.cssText = 'filter:drop-shadow(0 2px 5px rgba(0,0,0,.28));position:relative;cursor:pointer;';
    if (u.avatarUrl) {
      const img = safeImg(u.avatarUrl, null, u.username);
      img.style.cssText = 'width:36px;height:36px;border-radius:50%;object-fit:cover;';
      avDiv.appendChild(img);
    } else {
      avDiv.innerHTML = makeAv(u.avatar||0, 36);
    }
    const dot = document.createElement('div'); dot.className=`sdot ${u.status}`; dot.style.cssText='width:9px;height:9px;border-color:rgba(18,72,172,.5);';
    avDiv.appendChild(dot);
    // Click avatar to view profile
    avDiv.addEventListener('click', e => { e.stopPropagation(); api.getProfile(u.username); });

    const info = document.createElement('div'); info.className='ci-info';
    const name = document.createElement('div'); name.className='ci-name'; name.textContent=u.username;
    const prev = document.createElement('div'); prev.className='ci-preview'; prev.textContent=preview.slice(0,40);
    info.append(name, prev);

    const meta = document.createElement('div'); meta.className='ci-meta';
    const time = document.createElement('div'); time.className='ci-time'; time.textContent=timeStr;
    meta.appendChild(time);
    if (badge) { const b=document.createElement('div'); b.className='ci-badge'; b.textContent=badge; meta.appendChild(b); }

    el.append(avDiv, info, meta);
    el.addEventListener('click', () => openChat(u.username));
    list.appendChild(el);
  });
}

// ── OPEN CHAT ──────────────────────────────────────────────────────
function openChat(username) {
  activeChat = username; activeRoom = null;
  unread[username] = 0; iconState.update();
  $('chatEmpty').classList.add('hidden');
  $('chatPanel').classList.remove('hidden');
  $('typingRow').classList.add('hidden');
  $('nudgeBtn').style.display = '';

  updateChatHeader(); renderContacts(); renderRoomsList();
  if (convos[username]) renderMessages();
  api.history(username); api.seen(username); iconState.update();
  $('msgInput').focus();
}

function updateChatHeader() {
  const u = users[activeChat];
  if (!u) return;
  const statusIcons = { online:'🟢', away:'🟡', busy:'🔴', invisible:'⚫', offline:'⚫' };
  $('chName').textContent = u.username;
  $('chStatus').textContent = `${statusIcons[u.status]||'⚫'} ${u.status.charAt(0).toUpperCase()+u.status.slice(1)}${u.mood ? ' · "'+u.mood+'"' : ''}`;
  const chAv = $('chAv');
  if (u.avatarUrl) {
    const img = safeImg(u.avatarUrl, null, u.username);
    img.style.cssText='width:40px;height:40px;border-radius:50%;object-fit:cover;';
    chAv.innerHTML=''; chAv.appendChild(img);
  } else {
    chAv.innerHTML = makeAv(u.avatar||0, 40) + `<div class="sdot ${u.status}" style="width:11px;height:11px;border-color:rgba(172,218,252,.7);"></div>`;
  }
  chAv.style.cssText='position:relative;filter:drop-shadow(0 3px 7px rgba(0,0,0,.26));flex-shrink:0;cursor:pointer;';
  chAv.onclick = () => api.getProfile(u.username);

  const tAv = $('typingAv'); tAv.innerHTML = makeAv(u.avatar||0, 28);
  tAv.style.cssText = 'filter:drop-shadow(0 2px 4px rgba(0,0,0,.22));flex-shrink:0;';
}

// ── RENDER MESSAGES ────────────────────────────────────────────────
function renderMessages() {
  const inner = $('msgsInner'); inner.innerHTML = '';
  const sep = document.createElement('div'); sep.className='date-sep'; sep.textContent='Today';
  inner.appendChild(sep);
  const msgs = activeRoom ? (roomMsgs[activeRoom]||[]) : (convos[activeChat]||[]);
  msgs.forEach(msg => appendMsgEl(msg, inner, false));
  scrollToBottom(); updateSeenTicks();
}

function appendMsgToDOM(msg, isRoom) {
  const inner = $('msgsInner');
  appendMsgEl(msg, inner, true);
  scrollToBottom(); updateSeenTicks();
}

function appendMsgEl(msg, container, animate) {
  const mine  = msg.from === me.username;
  const u     = mine ? me : (users[msg.from] || { avatar: 0 });
  const row = document.createElement('div');
  row.className = 'msg-row' + (mine ? ' mine' : '');
  row.dataset.msgId = msg.id;
  if (!animate) row.style.animation = 'none';

  // Avatar
  const avEl = document.createElement('div');
  avEl.style.cssText = 'flex-shrink:0;filter:drop-shadow(0 2px 5px rgba(0,0,0,.22));';
  if (u.avatarUrl) {
    const img = safeImg(u.avatarUrl, null, u.username||'');
    img.style.cssText='width:28px;height:28px;border-radius:50%;object-fit:cover;';
    avEl.appendChild(img);
  } else {
    avEl.innerHTML = makeAv(mine ? me.avatar : (u.avatar||0), 28);
  }
  row.appendChild(avEl);

  if (msg.fileUrl) {
    // File attachment bubble
    const url = resolveFileUrl(msg.fileUrl);
    const isImg = /\.(jpg|jpeg|png|gif|webp)$/i.test(msg.fileUrl);
    if (isImg) {
      const bubbleImg = document.createElement('div');
      bubbleImg.className = 'bubble-img' + (mine ? ' mine' : '');
      bubbleImg.title = 'Click to enlarge';
      const imgEl = safeImg(url, null, 'image');
      imgEl.setAttribute('loading','lazy');
      bubbleImg.appendChild(imgEl);
      bubbleImg.addEventListener('click', () => openLightbox(url));
      row.appendChild(bubbleImg);
      playImageSound();
    } else {
      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + (mine ? 'bubble-mine' : 'bubble-them');
      const link = document.createElement('a');
      link.href = url; link.target='_blank'; link.download=msg.fileName||'file';
      link.textContent = '📎 ' + (msg.fileName||'Download file');
      link.style.cssText = mine ? 'color:rgba(255,255,255,.9);text-decoration:underline;' : 'color:#1060c0;text-decoration:underline;';
      bubble.appendChild(link);
      row.appendChild(bubble);
    }
  } else if (msg.image) {
    const imgEl = safeImg(msg.image, null, 'image');
    imgEl.setAttribute('loading','lazy');
    const bubbleImg = document.createElement('div');
    bubbleImg.className = 'bubble-img' + (mine ? ' mine' : '');
    bubbleImg.title = 'Click to enlarge';
    bubbleImg.appendChild(imgEl);
    if (msg.text) { const cap=document.createElement('div'); cap.className='img-caption'; cap.textContent=msg.text; bubbleImg.appendChild(cap); }
    bubbleImg.addEventListener('click', () => openLightbox(msg.image));
    row.appendChild(bubbleImg);
    if (mine) { row.appendChild(buildMsgActions(msg)); wireActions(row, msg); }
  } else {
    const emojiOnly = isEmojiOnly(msg.text);
    const bubble = document.createElement('div');
    bubble.className = 'bubble ' + (emojiOnly ? 'bubble-emoji' : (mine ? 'bubble-mine' : 'bubble-them'));
    bubble.innerHTML = escHtml(msg.text);
    row.appendChild(bubble);
    if (msg.edited) { const e=document.createElement('div'); e.className='msg-edited'; e.textContent='(edited)'; row.appendChild(e); }
    if (mine) { row.appendChild(buildMsgActions(msg)); wireActions(row, msg); }
    bubble.addEventListener('contextmenu', e => { e.preventDefault(); buildReactionPicker(msg, row); });
  }

  // Reaction bar
  const reactionBar = buildReactionBar(msg.id, msg);
  if (reactionBar) row.appendChild(reactionBar);

  const time = document.createElement('div'); time.className='msg-time'; time.textContent=fmtTime(msg.time);
  row.appendChild(time);
  container.appendChild(row);
}

function buildReactionBar(msgId, msg) {
  const msgReactions = reactions[msgId];
  if (!msgReactions || Object.keys(msgReactions).length === 0) return null;
  const bar = document.createElement('div'); bar.className='reaction-bar';
  Object.entries(msgReactions).forEach(([emoji, usersArr]) => {
    if (!usersArr || usersArr.length === 0) return;
    const isMine = Array.isArray(usersArr) ? usersArr.includes(me.username) : usersArr.has?.(me.username);
    const chip = document.createElement('div');
    chip.className = 'reaction-chip' + (isMine ? ' mine' : '');
    chip.textContent = emoji + ' ' + usersArr.length;
    chip.title = Array.isArray(usersArr) ? usersArr.join(', ') : [...usersArr].join(', ');
    chip.addEventListener('click', () => toggleReaction(msgId, emoji, msg));
    bar.appendChild(chip);
  });
  return bar.children.length > 0 ? bar : null;
}

function buildMsgActions(msg) {
  const wrap = document.createElement('div'); wrap.className='msg-actions';
  if (!msg.image && !msg.fileUrl) {
    const editBtn = document.createElement('div'); editBtn.className='msg-action-btn edit'; editBtn.title='Edit'; editBtn.textContent='✏️';
    wrap.appendChild(editBtn);
  }
  const delBtn = document.createElement('div'); delBtn.className='msg-action-btn delete'; delBtn.title='Delete'; delBtn.textContent='🗑️';
  wrap.appendChild(delBtn);
  return wrap;
}

function wireActions(row, msg) {
  const editBtn = row.querySelector('.msg-action-btn.edit');
  const delBtn  = row.querySelector('.msg-action-btn.delete');
  if (editBtn) editBtn.addEventListener('click', e => { e.stopPropagation(); startEdit(row, msg); });
  if (delBtn)  delBtn.addEventListener('click',  e => { e.stopPropagation(); deleteMsg(msg); });
}

function startEdit(row, msg) {
  const bubble = row.querySelector('.bubble'); if (!bubble) return;
  const originalText = msg.text;
  const wrap = document.createElement('div'); wrap.className='bubble-edit-wrap';
  const ta = document.createElement('textarea'); ta.className='bubble-edit-input'; ta.rows=2; ta.value=originalText;
  const actions = document.createElement('div'); actions.className='bubble-edit-actions';
  const saveBtn   = document.createElement('button'); saveBtn.className='bubble-edit-save'; saveBtn.textContent='Save';
  const cancelBtn = document.createElement('button'); cancelBtn.className='bubble-edit-cancel'; cancelBtn.textContent='Cancel';
  actions.append(saveBtn, cancelBtn); wrap.append(ta, actions);
  bubble.style.display='none';
  const actionsEl=row.querySelector('.msg-actions'), editedEl=row.querySelector('.msg-edited');
  if (actionsEl) actionsEl.style.display='none'; if (editedEl) editedEl.style.display='none';
  row.insertBefore(wrap, bubble.nextSibling); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  saveBtn.addEventListener('click', () => {
    const newText = ta.value.trim(); if (!newText || newText===originalText) { cancelEdit(); return; }
    api.edit(msg.id, activeChat, newText, activeRoom);
    msg.text=newText; msg.edited=true;
    bubble.innerHTML=escHtml(newText); bubble.style.display=''; if (actionsEl) actionsEl.style.display='';
    wrap.remove();
    let el=row.querySelector('.msg-edited');
    if (!el) { el=document.createElement('div'); el.className='msg-edited'; el.textContent='(edited)'; bubble.insertAdjacentElement('afterend',el); }
    else el.style.display='';
  });
  const cancelEdit = () => { bubble.style.display=''; if(actionsEl) actionsEl.style.display=''; if(editedEl) editedEl.style.display=''; wrap.remove(); };
  cancelBtn.addEventListener('click', cancelEdit);
  ta.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();saveBtn.click();} if(e.key==='Escape') cancelEdit(); });
}

function deleteMsg(msg) {
  api.del(msg.id, activeChat, activeRoom);
  if (activeRoom) { if(roomMsgs[activeRoom]) roomMsgs[activeRoom]=roomMsgs[activeRoom].filter(m=>m.id!==msg.id); }
  else { if(convos[activeChat]) convos[activeChat]=convos[activeChat].filter(m=>m.id!==msg.id); }
  renderMessages();
}

function scrollToBottom() { const area=$('messagesArea'); requestAnimationFrame(()=>{ area.scrollTop=area.scrollHeight; }); }

// ── SEND MESSAGE ───────────────────────────────────────────────────
function sendMessage() {
  if ((!activeChat && !activeRoom) || !socket) return;

  if (pendingFile) {
    const { dataUrl, url, name, isImage, serverPath } = pendingFile;
    const msgId = Date.now()+'_'+Math.random().toString(36).slice(2);
    const now   = new Date().toISOString();

    if (activeRoom) {
      const msg = { id: msgId, roomId: activeRoom, from: me.username, text: '', fileUrl: url||dataUrl||null, fileName: name, time: now, reactions: {} };
      if (!roomMsgs[activeRoom]) roomMsgs[activeRoom] = [];
      roomMsgs[activeRoom].push(msg); capConvo(activeRoom, roomMsgs);
      appendMsgToDOM(msg, true);
      api.roomMsg(activeRoom, '', url||null, name);
    } else {
      const msg = { id: msgId, from: me.username, to: activeChat, text: '', image: dataUrl||null, fileUrl: url||null, fileName: name, time: now, reactions: {} };
      if (!convos[activeChat]) convos[activeChat] = [];
      convos[activeChat].push(msg); capConvo(activeChat, convos);
      appendMsgToDOM(msg, false);
      if (dataUrl && isImage) api.send(activeChat, '', dataUrl, null, null);
      else api.send(activeChat, '', null, url, name);
    }
    clearFilePreview(); playSendBlip(); if (isImage) playImageSound();
    renderContacts(); return;
  }

  const ta = $('msgInput');
  const text = ta.value.trim();
  if (!text) return;

  const msgId = Date.now()+'_'+Math.random().toString(36).slice(2);
  const now   = new Date().toISOString();

  if (activeRoom) {
    const msg = { id: msgId, roomId: activeRoom, from: me.username, text, time: now, reactions: {} };
    if (!roomMsgs[activeRoom]) roomMsgs[activeRoom] = [];
    roomMsgs[activeRoom].push(msg); capConvo(activeRoom, roomMsgs);
    appendMsgToDOM(msg, true);
    api.roomMsg(activeRoom, text);
  } else {
    const msg = { id: msgId, from: me.username, to: activeChat, text, time: now, reactions: {} };
    if (!convos[activeChat]) convos[activeChat] = [];
    convos[activeChat].push(msg); capConvo(activeChat, convos);
    appendMsgToDOM(msg, false); renderContacts();
    api.send(activeChat, text);
    api.typStop(activeChat, null);
  }

  playSendBlip();
  ta.value = ''; ta.style.height = 'auto'; ta.focus();
}

// ── MISC ───────────────────────────────────────────────────────────
function wrapSelection(ta, before, after) {
  const start=ta.selectionStart, end=ta.selectionEnd, val=ta.value;
  if (start===end) { ta.value=val.slice(0,start)+before+after+val.slice(end); ta.selectionStart=ta.selectionEnd=start+before.length; }
  else { const sel=val.slice(start,end); ta.value=val.slice(0,start)+before+sel+after+val.slice(end); ta.selectionStart=start+before.length; ta.selectionEnd=start+before.length+sel.length; }
}

function triggerNudge() {
  const win=$('appScreen'); win.classList.remove('nudging'); void win.offsetWidth;
  win.classList.add('nudging'); win.addEventListener('animationend',()=>win.classList.remove('nudging'),{once:true});
}

// ── BOOT ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildAvatarPicker();
  $('loginBtn').addEventListener('click', attemptLogin);
  $('loginUsername').addEventListener('keydown', e => { if(e.key==='Enter') attemptLogin(); });
  $('loginServer').addEventListener('keydown',   e => { if(e.key==='Enter') attemptLogin(); });
});

// ── LOGIN HOST PANEL (unchanged from v3) ──────────────────────────
(function initLoginHostPanel() {
  if (!window.talkity || !window.talkity.serverStart) return;
  const panel = $('loginHostPanel'); if (panel) panel.classList.remove('hidden');
  let hostRunning=false, hostMode='lan', expanded=false;
  const elToggle=$('lhpToggle'),elChevron=$('lhpChevron'),elBody=$('lhpBody'),elDot=$('lhpDot');
  const elModeLan=$('lhpModeLan'),elModeNgrok=$('lhpModeNgrok'),elNgrokHint=$('lhpNgrokHint'),elNgrokLink=$('lhpNgrokLink');
  const elStartBtn=$('lhpStartBtn'),elStartText=$('lhpStartText'),elAddr=$('lhpAddr');
  const elLanRow=$('lhpLanRow'),elNgrokRow=$('lhpNgrokRow'),elLanVal=$('lhpLanVal'),elNgrokVal=$('lhpNgrokVal');
  const elNgrokErr=$('lhpNgrokErr'),elCopyLan=$('lhpCopyLan'),elCopyNgrok=$('lhpCopyNgrok'),elLog=$('lhpLog');
  function setExpanded(v){expanded=v;elBody.classList.toggle('hidden',!v);elChevron.classList.toggle('open',v);}
  elToggle.addEventListener('click',()=>setExpanded(!expanded));
  function setMode(m){hostMode=m;elModeLan.classList.toggle('active',m==='lan');elModeNgrok.classList.toggle('active',m==='ngrok');elNgrokHint.classList.toggle('hidden',m==='lan');}
  elModeLan.addEventListener('click',()=>{if(!hostRunning)setMode('lan');});
  elModeNgrok.addEventListener('click',()=>{if(!hostRunning)setMode('ngrok');});
  if(elNgrokLink)elNgrokLink.addEventListener('click',()=>window.open('https://ngrok.com/download','_blank'));
  function setDot(s){elDot.className='lhp-dot '+s;}
  function appendLog(line,isErr){while(elLog.children.length>=20)elLog.removeChild(elLog.firstChild);const el=document.createElement('div');el.className='lhp-log-line'+(isErr?' err':'');el.textContent=line;elLog.appendChild(el);elLog.scrollTop=elLog.scrollHeight;}
  function copyFeedback(btn,text){navigator.clipboard.writeText(text).then(()=>{const o=btn.textContent;btn.textContent='✓';btn.classList.add('copied');setTimeout(()=>{btn.textContent=o;btn.classList.remove('copied');},1800);});}
  elCopyLan.addEventListener('click',()=>copyFeedback(elCopyLan,elLanVal.textContent));
  elCopyNgrok.addEventListener('click',()=>copyFeedback(elCopyNgrok,elNgrokVal.textContent));
  function updateUI(data){
    if(data.running){setDot('running');elStartBtn.classList.remove('busy');elStartBtn.classList.add('stopping');elStartText.textContent='■ Stop Server';elAddr.classList.remove('hidden');elLanVal.textContent=data.lan||'—';elModeLan.style.pointerEvents='none';elModeNgrok.style.pointerEvents='none';const si=$('loginServer');if(si&&si.value==='localhost:3747')si.value=data.ngrok||data.lan||'localhost:3747';if(data.ngrok){elNgrokRow.classList.remove('hidden');elNgrokVal.textContent=data.ngrok;elNgrokErr.classList.add('hidden');}else if(data.ngrokError){elNgrokErr.textContent='⚠ '+data.ngrokError;elNgrokErr.classList.remove('hidden');}}
    else{setDot('idle');elStartBtn.classList.remove('busy','stopping');elStartText.textContent='▶ Start Server';elAddr.classList.add('hidden');elNgrokRow.classList.add('hidden');elNgrokErr.classList.add('hidden');elModeLan.style.pointerEvents='';elModeNgrok.style.pointerEvents='';}
  }
  elStartBtn.addEventListener('click',async()=>{
    if(hostRunning){elStartBtn.classList.add('busy');elStartText.textContent='⏳ Stopping...';await window.talkity.serverStop();hostRunning=false;updateUI({running:false});appendLog('Server stopped.');const si=$('loginServer');if(si)si.value='localhost:3747';}
    else{elStartBtn.classList.add('busy');elStartText.textContent='⏳ Starting...';setDot('starting');setExpanded(true);appendLog('Starting server'+(hostMode==='ngrok'?' + ngrok tunnel...':'...'));const result=await window.talkity.serverStart({useNgrok:hostMode==='ngrok'});if(!result.ok){setDot('error');elStartBtn.classList.remove('busy');elStartText.textContent='▶ Start Server';appendLog('❌ '+(result.error||'Failed to start'),true);return;}hostRunning=true;updateUI({running:true,lan:result.lan,ngrok:result.ngrok,ngrokError:result.ngrokError});appendLog('✅ Server running on '+result.lan);if(result.ngrok)appendLog('🌐 Tunnel: '+result.ngrok);if(result.ngrokError)appendLog('⚠ ngrok: '+result.ngrokError,true);}
  });
  window.talkity.onServerStatus(data=>{hostRunning=data.running;updateUI(data);});
  window.talkity.onServerLog(line=>{appendLog(line,line.startsWith('⚠')||line.startsWith('❌'));});
  window.talkity.serverGetStatus().then(data=>{if(data.running){hostRunning=true;updateUI(data);}});
})();

// ── APP HOST PANEL (unchanged from v3) ───────────────────────────
(function initHostPanel() {
  if (!window.talkity || !window.talkity.serverStart) return;
  let hostRunning=false,hostMode='lan',expanded=false;
  const elCollapsed=$('hostCollapsed'),elExpanded=$('hostExpanded'),elExpandBtn=$('hostExpandBtn'),elCollapseBtn=$('hostCollapseBtn');
  const elDot=$('hostDot'),elDot2=$('hostDot2'),elModeLan=$('modeLan'),elModeNgrok=$('modeNgrok');
  const elNgrokHint=$('hostNgrokHint'),elStartBtn=$('hostStartBtn'),elStartText=$('hostStartText');
  const elAddrCard=$('hostAddrCard'),elLanRow=$('hostLanRow'),elNgrokRow=$('hostNgrokRow');
  const elLanVal=$('hostLanVal'),elNgrokVal=$('hostNgrokVal'),elNgrokErr=$('hostNgrokErr');
  const elCopyLan=$('hostCopyLan'),elCopyNgrok=$('hostCopyNgrok'),elLog=$('hostLog'),elNgrokLink=$('ngrokLink');
  function setExpanded(v){expanded=v;elCollapsed.classList.toggle('hidden',v);elExpanded.classList.toggle('hidden',!v);}
  elExpandBtn.addEventListener('click',()=>setExpanded(true));elCollapseBtn.addEventListener('click',()=>setExpanded(false));
  function setMode(m){hostMode=m;elModeLan.classList.toggle('active',m==='lan');elModeNgrok.classList.toggle('active',m==='ngrok');elNgrokHint.classList.toggle('hidden',m==='lan');}
  elModeLan.addEventListener('click',()=>{if(!hostRunning)setMode('lan');});elModeNgrok.addEventListener('click',()=>{if(!hostRunning)setMode('ngrok');});
  if(elNgrokLink)elNgrokLink.addEventListener('click',()=>window.open('https://ngrok.com/download','_blank'));
  function setDotState(s){[elDot,elDot2].forEach(d=>{d.className='host-status-dot '+s;});}
  function appendLog(line,isErr){while(elLog.children.length>=30)elLog.removeChild(elLog.firstChild);const el=document.createElement('div');el.className='host-log-line'+(isErr?' err':'');el.textContent=line;elLog.appendChild(el);elLog.scrollTop=elLog.scrollHeight;}
  function copyWithFeedback(btn,text){navigator.clipboard.writeText(text).then(()=>{const o=btn.textContent;btn.textContent='✓';btn.classList.add('copied');setTimeout(()=>{btn.textContent=o;btn.classList.remove('copied');},1800);});}
  elCopyLan.addEventListener('click',()=>copyWithFeedback(elCopyLan,elLanVal.textContent));
  elCopyNgrok.addEventListener('click',()=>copyWithFeedback(elCopyNgrok,elNgrokVal.textContent));
  function updateUI(data){
    if(data.running){setDotState('running');elStartBtn.classList.remove('busy');elStartBtn.classList.add('stopping');elStartText.textContent='■ Stop Server';elAddrCard.classList.remove('hidden');elLanVal.textContent=data.lan||'—';elModeLan.style.pointerEvents='none';elModeNgrok.style.pointerEvents='none';if(data.ngrok){elNgrokRow.classList.remove('hidden');elNgrokVal.textContent=data.ngrok;elNgrokErr.classList.add('hidden');}else if(data.ngrokError){elNgrokErr.textContent='⚠ '+data.ngrokError;elNgrokErr.classList.remove('hidden');}}
    else{setDotState('idle');elStartBtn.classList.remove('busy','stopping');elStartText.textContent='▶ Start Server';elAddrCard.classList.add('hidden');elNgrokRow.classList.add('hidden');elNgrokErr.classList.add('hidden');elModeLan.style.pointerEvents='';elModeNgrok.style.pointerEvents='';}
  }
  window.talkity.onServerStatus(data=>{hostRunning=data.running;updateUI(data);});
  window.talkity.onServerLog(line=>{appendLog(line,line.startsWith('⚠')||line.startsWith('❌'));});
  elStartBtn.addEventListener('click',async()=>{
    if(hostRunning){elStartBtn.classList.add('busy');elStartText.textContent='⏳ Stopping...';await window.talkity.serverStop();setDotState('idle');elStartBtn.classList.remove('busy','stopping');elStartText.textContent='▶ Start Server';elAddrCard.classList.add('hidden');elNgrokRow.classList.add('hidden');elNgrokErr.classList.add('hidden');elModeLan.style.pointerEvents='';elModeNgrok.style.pointerEvents='';hostRunning=false;appendLog('Server stopped.');}
    else{elStartBtn.classList.add('busy');elStartText.textContent='⏳ Starting...';setDotState('starting');appendLog('Starting server'+(hostMode==='ngrok'?' + ngrok tunnel...':'...'));const result=await window.talkity.serverStart({useNgrok:hostMode==='ngrok'});if(!result.ok){setDotState('error');elStartBtn.classList.remove('busy');elStartText.textContent='▶ Start Server';appendLog('❌ '+(result.error||'Failed to start'),true);return;}hostRunning=true;updateUI({running:true,lan:result.lan,ngrok:result.ngrok,ngrokError:result.ngrokError});appendLog('✅ Server running on '+result.lan);if(result.ngrok)appendLog('🌐 Tunnel: '+result.ngrok);if(result.ngrokError)appendLog('⚠ ngrok: '+result.ngrokError,true);const si=$('loginServer');if(si&&si.value==='localhost:3747')si.value=result.ngrok||result.lan||'localhost:3747';}
  });
  window.talkity.serverGetStatus().then(data=>{if(data.running){hostRunning=true;updateUI(data);}});
})();

// ── ADD FRIEND INPUT (wired after DOM ready) ─────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Handled inside initApp after socket connects — add friend input
  setTimeout(() => {
    const inp = document.getElementById('addFriendInput');
    if (inp) {
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          const name = inp.value.trim();
          if (name && name !== (window._me_username||'')) { api.friendReq(name); inp.value = ''; }
        }
      });
    }
  }, 2000);
});