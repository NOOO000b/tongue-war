// 舌戰：多人連線伺服器
// 移動由玩家自己的電腦計算（盪鞦韆手感才不會有延遲），
// 抓人、拉扯、繞柱斷線、吃人、計分由伺服器判定，大家看到的結果才會一致。
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

// ===== 規則參數（和遊戲裡的對戰電腦模式一樣）=====
const RANGE = 50;           // 舌頭射程
const PULL_BASE = 5;        // 抓到人之後，舌頭自己收回的速度
const CLICK_BOOST = 2;      // 每點一下，拉的速度增加多少
const MAX_BOOST = 8;        // 連點加速上限
const BOOST_DECAY = 4;      // 加速消退速度
const EAT_DIST = 2.0;       // 拉到嘴巴前多近算吃掉
const DIGEST = 4;           // 嚼多久（被吃的人幾秒後重生）
const MATCH_TIME = +process.env.MATCH_TIME || 360;     // 一場 6 分鐘（測試時可用環境變數縮短）
const RESULT_TIME = 10;     // 結算畫面幾秒
const MAX_PLAYERS = 10;
const TICK = 1 / 30, SEND_EVERY = 2;   // 每秒算 30 次、送 15 次狀態

// ===== 地圖：和遊戲裡用同一個亂數種子，算出一模一樣的樹幹和浮石 =====
let seed = 11;
const R = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const trunks = [], rocks = [];
for (let i = 0; i < 26; i++) {
  const x = (R() - 0.5) * 150, z = (R() - 0.5) * 150;
  if (Math.hypot(x, z) < 12) continue;
  const r = 1.8 + R() * 2, h = 14 + R() * 30;
  trunks.push([x, z, r, h]);
}
for (let i = 0; i < 12; i++) {
  const x = (R() - 0.5) * 150, z = (R() - 0.5) * 150, y = 26 + R() * 22, r = 2.5 + R() * 2.5;
  rocks.push([x, y, z, r]);
}

// ===== 小工具 =====
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function segPoint(a, b, c) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(c, a), ab) / (dot(ab, ab) || 1)));
  return { d: dist([a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t], c), t };
}
// 兩點之間有沒有被樹幹或浮石擋住（繞柱斷線）
function lineBlocked(a, b) {
  for (const [x, z, r, h] of trunks) {
    const { d, t } = segPoint([a[0], 0, a[2]], [b[0], 0, b[2]], [x, 0, z]);
    if (d < r * 0.92 && a[1] + (b[1] - a[1]) * t < h) return true;
  }
  for (const [x, y, z, r] of rocks) if (segPoint(a, b, [x, y, z]).d < r * 0.85) return true;
  return false;
}
// 嘴巴的大概位置（身體中心往上一點、往面向的方向一點）
const mouthOf = (p) => [p.pos[0] - Math.sin(p.face) * 0.8, p.pos[1] + 0.4, p.pos[2] - Math.cos(p.face) * 0.8];
function spawnPoint(team, others) {
  // 紅隊從 +z 那一側出生，藍隊從 -z 那一側
  for (let i = 0; i < 80; i++) {
    const x = (Math.random() - 0.5) * 150, z = (team === 'red' ? 1 : -1) * (35 + Math.random() * 45);
    if (trunks.some(([tx, tz, r]) => Math.hypot(x - tx, z - tz) < r + 3)) continue;
    if (others.some((q) => Math.hypot(q[0] - x, q[2] - z) < 6)) continue;
    return [x, 1, z];
  }
  return [0, 1, team === 'red' ? 60 : -60];
}
const TEAM_COLORS = {
  red: ['#e0892a', '#e8564a', '#f2b632', '#e86fa3', '#c9692e'],
  blue: ['#3f8fd1', '#2fb3b8', '#9b6bd6', '#5a6fe0', '#47a3e8'],
};
const cleanName = (s) => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 10) || '無名蛙';
const cleanRoom = (s) => String(s || '').replace(/[^\w\u4e00-\u9fff-]/g, '').slice(0, 16) || '大廳';
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const vec = (a, d) => (Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a : d);

// ===== 房間 =====
const rooms = new Map();
function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { code, players: new Map(), grabs: [], score: { red: 0, blue: 0 }, endsAt: Date.now() + MATCH_TIME * 1000, phase: 'play', tick: 0 });
  return rooms.get(code);
}
function pickTeam(room) {
  let red = 0, blue = 0;
  for (const p of room.players.values()) p.team === 'red' ? red++ : blue++;
  return red <= blue ? 'red' : 'blue';
}
function pickColor(room, team) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  return TEAM_COLORS[team].find((c) => !used.has(c)) || TEAM_COLORS[team][0];
}
const emitRoom = (room, ev, data) => io.to(room.code).emit(ev, data);

function releaseGrab(room, g, reason) {
  room.grabs = room.grabs.filter((x) => x !== g);
  emitRoom(room, 'release', { att: g.att, vic: g.vic, reason });
}
function startGrab(room, att, vic) {
  // 被抓的人如果正在拉別人，就放掉（隊友救援就是靠這個：抓住正在拉你隊友的敵人）
  for (const g of room.grabs.filter((g) => g.att === vic.id)) releaseGrab(room, g, 'rescued');
  const g = { att: att.id, vic: vic.id, L: dist(mouthOf(att), vic.pos), boost: 0 };
  room.grabs.push(g);
  emitRoom(room, 'grab', { att: att.id, vic: vic.id });
}
function eat(room, g) {
  const att = room.players.get(g.att), vic = room.players.get(g.vic);
  room.grabs = room.grabs.filter((x) => x !== g);
  for (const o of room.grabs.filter((o) => o.att === vic.id || o.vic === vic.id)) releaseGrab(room, o, null);
  vic.eatenBy = att.id; vic.respawnAt = Date.now() + DIGEST * 1000; vic.deaths++;
  att.eats++;
  if (room.phase === 'play') room.score[att.team]++;
  emitRoom(room, 'eat', { att: att.id, vic: vic.id });
}
function respawn(room, p) {
  p.eatenBy = null;
  const others = [...room.players.values()].filter((o) => o !== p).map((o) => o.pos);
  p.pos = spawnPoint(p.team, others); p.vel = [0, 0, 0];
  io.to(p.id).emit('respawn', { pos: p.pos });
}
function newMatch(room) {
  room.phase = 'play'; room.score = { red: 0, blue: 0 }; room.endsAt = Date.now() + MATCH_TIME * 1000;
  for (const g of [...room.grabs]) releaseGrab(room, g, null);
  for (const p of room.players.values()) { p.eats = 0; p.deaths = 0; respawn(room, p); }
  emitRoom(room, 'match', { phase: 'play' });
}

io.on('connection', (socket) => {
  let room = null, me = null;

  socket.on('join', ({ name, room: code } = {}) => {
    if (room) return;
    const r = getRoom(cleanRoom(code));
    if (r.players.size >= MAX_PLAYERS) return socket.emit('full');
    room = r; socket.join(room.code);
    const team = pickTeam(room);
    me = { id: socket.id, name: cleanName(name), team, color: pickColor(room, team), pos: [0, 1, 0], vel: [0, 0, 0],
      face: 0, tip: null, tp: null, aim: false, gnd: true, eats: 0, deaths: 0, eatenBy: null, respawnAt: 0 };
    room.players.set(me.id, me);
    me.pos = spawnPoint(team, [...room.players.values()].filter((o) => o !== me).map((o) => o.pos));
    socket.emit('welcome', { id: me.id, room: room.code, team, color: me.color, pos: me.pos, matchTime: MATCH_TIME,
      endsAt: room.endsAt - Date.now(), phase: room.phase, score: room.score });
    emitRoom(room, 'note', `${me.name} 加入了${team === 'red' ? '紅' : '藍'}隊`);
  });

  // 玩家自己回報的狀態（每秒約 20 次）
  socket.on('st', (s = {}) => {
    if (!me || me.eatenBy) return;
    me.pos = vec(s.p, me.pos); me.vel = vec(s.v, me.vel);
    me.face = num(s.f, me.face); me.gnd = !!s.g; me.aim = !!s.a;
    me.tp = typeof s.tp === 'string' ? s.tp.slice(0, 6) : null;
    me.tip = s.tip ? vec(s.tip, null) : null;
  });

  // 舌頭打中別人：伺服器檢查合不合理，再決定算不算抓到
  socket.on('grab', ({ vic: vid } = {}) => {
    if (!me || room.phase !== 'play' || me.eatenBy) return;
    const vic = room.players.get(vid);
    const bad = !vic || vic === me || vic.team === me.team || vic.eatenBy
      || room.grabs.some((g) => g.vic === vid || g.vic === me.id || g.att === me.id)
      || dist(me.pos, vic.pos) > RANGE + 6 || lineBlocked(mouthOf(me), vic.pos);
    if (bad) return socket.emit('grabDenied', { vic: vid });
    startGrab(room, me, vic);
  });

  // 拉人時每點一下加速（只有準星對準時才算）
  socket.on('click', () => {
    if (!me) return;
    const g = room.grabs.find((g) => g.att === me.id);
    if (g && me.aim) g.boost = Math.min(MAX_BOOST, g.boost + CLICK_BOOST);
  });

  socket.on('disconnect', () => {
    if (!room || !me) return;
    for (const g of room.grabs.filter((g) => g.att === me.id || g.vic === me.id)) releaseGrab(room, g, null);
    room.players.delete(me.id);
    emitRoom(room, 'note', `${me.name} 離開了`);
    if (room.players.size === 0) rooms.delete(room.code);
  });
});

// ===== 遊戲主迴圈 =====
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    // 拉扯
    for (const g of [...room.grabs]) {
      const att = room.players.get(g.att), vic = room.players.get(g.vic);
      if (!att || !vic || att.eatenBy || vic.eatenBy) { releaseGrab(room, g, null); continue; }
      const anchor = mouthOf(att);
      if (lineBlocked(anchor, vic.pos)) { releaseGrab(room, g, 'snap'); continue; }
      g.boost = Math.max(0, g.boost - BOOST_DECAY * TICK);
      g.L = Math.max(0, Math.min(g.L, dist(anchor, vic.pos) + 0.5) - (att.aim ? PULL_BASE + g.boost : 0) * TICK);
      if (g.L <= EAT_DIST) eat(room, g);
    }
    // 重生
    for (const p of room.players.values()) if (p.eatenBy && now >= p.respawnAt) respawn(room, p);
    // 比賽時間
    if (room.phase === 'play' && now >= room.endsAt) {
      room.phase = 'results'; room.endsAt = now + RESULT_TIME * 1000;
      for (const g of [...room.grabs]) releaseGrab(room, g, null);
      const { red, blue } = room.score;
      emitRoom(room, 'match', { phase: 'results', winner: red === blue ? 'tie' : red > blue ? 'red' : 'blue', score: room.score });
    } else if (room.phase === 'results' && now >= room.endsAt) newMatch(room);
    // 送出房間狀態
    if (++room.tick % SEND_EVERY) continue;
    const r1 = (n) => Math.round(n * 100) / 100;
    emitRoom(room, 'snap', {
      t: now, left: Math.max(0, room.endsAt - now), phase: room.phase, score: room.score,
      players: [...room.players.values()].map((p) => ({
        id: p.id, n: p.name, team: p.team, c: p.color, p: p.pos.map(r1), v: p.vel.map(r1), f: r1(p.face),
        g: p.gnd, tp: p.tp, tip: p.tip && p.tip.map(r1), e: p.eatenBy, k: p.eats, d: p.deaths,
      })),
      grabs: room.grabs.map((g) => ({ att: g.att, vic: g.vic, L: r1(g.L), b: r1(g.boost) })),
    });
  }
}, TICK * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`舌戰伺服器已啟動：http://localhost:${PORT}`));
module.exports = { trunks, rocks };   // 給測試比對地圖用
