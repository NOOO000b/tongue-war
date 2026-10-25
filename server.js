// 舌戰：多人連線伺服器
// 移動由玩家自己的電腦計算（盪鞦韆手感才不會有延遲），
// 抓人、拉扯、繞柱斷線、吃人、計分、各模式規則由伺服器判定，大家看到的結果才會一致。
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

// ===== 共用規則參數 =====
const RANGE = 50, HUNTER_RANGE = 70;   // 舌頭射程（獵人比較遠）
const PULL_BASE = 5;        // 抓到人之後，舌頭自己收回的速度
const CLICK_BOOST = 2;      // 每點一下，拉的速度增加多少
const MAX_BOOST = 8;        // 連點加速上限
const BOOST_DECAY = 4;      // 加速消退速度
const EAT_DIST = 2.0;       // 拉到嘴巴前多近算吃掉
const DIGEST = 4;           // 嚼多久（會重生的模式，幾秒後重生）
const RESULT_TIME = 10;     // 結算畫面幾秒
const ROUND_BREAK = 5;      // 回合之間休息幾秒
const MAX_PLAYERS = 10;
const TICK = 1 / 30, SEND_EVERY = 2;   // 每秒算 30 次、送 15 次狀態
const T = (sec) => (+process.env.MATCH_TIME || sec);   // 測試時可以用環境變數把時間縮短

// ===== 模式 =====
const MODES = {
  team:    { name: '團隊吞噬戰', teams: true,  time: 360, desc: '吃掉對手得分，6 分鐘內得分多的隊伍獲勝' },
  elim:    { name: '全滅戰',     teams: true,  time: 180, rounds: 3, desc: '被吃就出局；隊友吃掉吃你的人就能救你出來。全隊出局就輸掉這回合，三戰兩勝' },
  egg:     { name: '搶蛋模式',   teams: true,  time: 480, desc: '把中間的蛋搬回自己的基地得分。拿著蛋會變慢、不能抓人' },
  hunt:    { name: '獵人與獵物', teams: false, time: 240, rounds: 3, desc: '獵人要吃光所有獵物；獵物撐到時間結束就贏，打中正在拉人的獵人可以救同伴' },
  race:    { name: '競速模式',   teams: false, time: 300, desc: '依序穿過空中的圈圈跑兩圈，先到終點的贏。舌頭可以把對手往回拉' },
  hill:    { name: '王者之山',   teams: true,  time: 360, desc: '只有你們隊站在發光區域裡時，每秒得 1 分。區域每 90 秒換位置' },
  glutton: { name: '大胃王',     teams: false, time: 420, desc: '個人大亂鬥：吃人得 1 分，吃掉頭戴皇冠的第一名得 2 分' },
};

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
const clearOf = (x, z, pad) => trunks.every(([tx, tz, r]) => Math.hypot(x - tx, z - tz) > r + pad);
function clearSpot(x, z, pad) {           // 從 (x,z) 往外找一個附近沒有樹幹的空地
  for (let k = 0; k < 40; k++) {
    const a = k * 2.4, d = k * 1.5, px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
    if (clearOf(px, pz, pad) && Math.abs(px) < 82 && Math.abs(pz) < 82) return [px, pz];
  }
  return [x, z];
}
// 搶蛋：蛋在中間，兩隊基地在兩端
const EGG_HOME = [0, 0.8, 0];
const BASES = { red: [...clearSpot(0, 70, 9)], blue: [...clearSpot(0, -70, 9)] }, BASE_R = 7;
// 王者之山：會輪流亮起的區域
const ZONES = [[0, 0], [45, 40], [-45, -40], [-45, 40], [45, -40]].map(([x, z]) => clearSpot(x, z, 10)), ZONE_R = 9, ZONE_MOVE = 90;
// 競速：沿著場地繞一圈的 8 個圈圈（放在兩棵樹中間的半空中，要用勾爪才過得去）
const RINGS = (() => {
  const picks = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const want = [Math.cos(a) * 48, Math.sin(a) * 48];
    picks.push(trunks.reduce((b, t) => (Math.hypot(t[0] - want[0], t[1] - want[1]) < Math.hypot(b[0] - want[0], b[1] - want[1]) ? t : b)));
  }
  return picks.map((t, k) => {
    const n = picks[(k + 1) % 8];
    return [(t[0] + n[0]) / 2, Math.min(t[3], n[3]) * 0.55, (t[1] + n[1]) / 2];
  });
})();
const RING_R = 4.5, LAPS = 2, RACE_CPS = RINGS.length * LAPS;

// ===== 小工具 =====
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
function segPoint(a, b, c) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(c, a), ab) / (dot(ab, ab) || 1)));
  return { d: dist([a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t], c), t };
}
function lineBlocked(a, b) {
  for (const [x, z, r, h] of trunks) {
    const { d, t } = segPoint([a[0], 0, a[2]], [b[0], 0, b[2]], [x, 0, z]);
    if (d < r * 0.92 && a[1] + (b[1] - a[1]) * t < h) return true;
  }
  for (const [x, y, z, r] of rocks) if (segPoint(a, b, [x, y, z]).d < r * 0.85) return true;
  return false;
}
const mouthOf = (p) => [p.pos[0] - Math.sin(p.face) * 0.8, p.pos[1] + 0.4, p.pos[2] - Math.cos(p.face) * 0.8];
function randomSpot(others, cx, cz, spread) {
  for (let i = 0; i < 80; i++) {
    const x = cx + (Math.random() - 0.5) * spread, z = cz + (Math.random() - 0.5) * spread;
    if (Math.abs(x) > 84 || Math.abs(z) > 84 || !clearOf(x, z, 3)) continue;
    if (others.some((q) => Math.hypot(q[0] - x, q[2] - z) < 6)) continue;
    return [x, 1, z];
  }
  return [cx, 1, cz];
}
const PALETTE = {
  red: ['#e0892a', '#e8564a', '#f2b632', '#e86fa3', '#c9692e'],
  blue: ['#3f8fd1', '#2fb3b8', '#9b6bd6', '#5a6fe0', '#47a3e8'],
  ffa: ['#5f9a2a', '#e0892a', '#3f8fd1', '#9b6bd6', '#e8564a', '#2fb3b8', '#f2b632', '#e86fa3', '#8a6d4a', '#6fc24a'],
};
const cleanName = (s) => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 10) || '無名蛙';
const cleanRoom = (s) => String(s || '').replace(/[^\w\u4e00-\u9fff-]/g, '').slice(0, 16);
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const vec = (a, d) => (Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a : d);
const TEAM_NAME = { red: '紅隊', blue: '藍隊' };

// ===== 房間 =====
const rooms = new Map();
function makeRoom(code, mode) {
  const room = { code, mode, M: MODES[mode], players: new Map(), grabs: [], phase: 'play', tick: 0, round: 1,
    score: { red: 0, blue: 0 }, wins: { red: 0, blue: 0 }, endsAt: 0, egg: null, zone: null, race: null, hunters: [], huntOrder: 0 };
  rooms.set(code, room);
  resetRound(room, true);
  return room;
}
const alive = (room) => [...room.players.values()].filter((p) => !p.out && !p.eatenBy);
const members = (room, team) => [...room.players.values()].filter((p) => p.team === team);
function pickTeam(room) {
  if (!room.M.teams) return room.mode === 'hunt' ? 'prey' : null;
  const red = members(room, 'red').length, blue = members(room, 'blue').length;
  return red <= blue ? 'red' : 'blue';
}
function pickColor(room, team) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  const pal = PALETTE[team === 'red' || team === 'blue' ? team : 'ffa'];
  return pal.find((c) => !used.has(c)) || pal[Math.floor(Math.random() * pal.length)];
}
function spawnFor(room, p) {
  const others = [...room.players.values()].filter((o) => o !== p).map((o) => o.pos);
  if (room.mode === 'egg') { const b = BASES[p.team]; return randomSpot(others, b[0], b[1], 22); }
  if (room.mode === 'race') return randomSpot(others, RINGS[RINGS.length - 1][0] * 0.5, RINGS[RINGS.length - 1][2] * 0.5, 14);
  if (room.mode === 'hunt') return p.role === 'hunter' ? randomSpot(others, 0, 0, 16) : randomSpot(others, (Math.random() < 0.5 ? 1 : -1) * 60, (Math.random() < 0.5 ? 1 : -1) * 60, 30);
  if (p.team === 'red' || p.team === 'blue') return randomSpot(others, 0, (p.team === 'red' ? 1 : -1) * 58, 140);
  return randomSpot(others, 0, 0, 160);
}
const emitRoom = (room, ev, data) => io.to(room.code).emit(ev, data);
const note = (room, text) => emitRoom(room, 'note', text);

function respawn(room, p) {
  p.eatenBy = null; p.out = false; p.heldBy = null;
  p.pos = spawnFor(room, p); p.vel = [0, 0, 0];
  io.to(p.id).emit('respawn', { pos: p.pos });
}
// 新的一回合（或新的一場）
function resetRound(room, fullMatch) {
  room.phase = 'play'; room.roundStart = Date.now();
  room.endsAt = Date.now() + T(room.M.time) * 1000;
  for (const g of [...room.grabs]) releaseGrab(room, g, null);
  if (fullMatch) { room.score = { red: 0, blue: 0 }; room.wins = { red: 0, blue: 0 }; room.round = 1; for (const p of room.players.values()) { p.k = 0; p.deaths = 0; } }
  if (room.mode === 'egg') room.egg = { pos: [...EGG_HOME], carrier: null, droppedAt: 0 };
  if (room.mode === 'hill') { room.zone = { i: 0, owner: null, movesAt: Date.now() + ZONE_MOVE * 1000, acc: 0 }; }
  if (room.mode === 'race') { room.race = { finished: [], firstAt: 0 }; for (const p of room.players.values()) { p.cp = 0; p.lastPos = null; } }
  if (room.mode === 'hunt') assignHunters(room);
  for (const p of room.players.values()) respawn(room, p);
}
function assignHunters(room) {
  const list = [...room.players.values()];
  const n = list.length >= 5 ? 2 : 1;
  for (const p of list) { p.role = 'prey'; p.team = 'prey'; }
  for (let i = 0; i < Math.min(n, list.length); i++) {
    const p = list[(room.huntOrder + i) % list.length];
    p.role = 'hunter'; p.team = 'hunter';
  }
  room.huntOrder += n;
  room.hunters = list.filter((p) => p.role === 'hunter').map((p) => p.id);
}

// ===== 抓人、拉扯、吃人 =====
function releaseGrab(room, g, reason) {
  room.grabs = room.grabs.filter((x) => x !== g);
  emitRoom(room, 'release', { att: g.att, vic: g.vic, reason });
}
function startGrab(room, att, vic) {
  for (const g of room.grabs.filter((g) => g.att === vic.id)) releaseGrab(room, g, 'rescued');
  const g = { att: att.id, vic: vic.id, L: dist(mouthOf(att), vic.pos), boost: 0, at: Date.now() };
  room.grabs.push(g);
  emitRoom(room, 'grab', { att: att.id, vic: vic.id });
}
function dropEgg(room, p) {
  if (room.egg && room.egg.carrier === p.id) { room.egg.carrier = null; room.egg.pos = [p.pos[0], 0.8, p.pos[2]]; room.egg.droppedAt = Date.now(); note(room, `${p.name} 的蛋掉了！`); }
}
function eat(room, g) {
  const att = room.players.get(g.att), vic = room.players.get(g.vic);
  room.grabs = room.grabs.filter((x) => x !== g);
  for (const o of room.grabs.filter((o) => o.att === vic.id || o.vic === vic.id)) releaseGrab(room, o, null);
  dropEgg(room, vic);
  vic.deaths++;
  const m = room.mode;
  if (m === 'elim' || m === 'hunt') {
    vic.eatenBy = att.id; vic.out = true; vic.heldBy = att.id; vic.respawnAt = Infinity;
  } else { vic.eatenBy = att.id; vic.respawnAt = Date.now() + DIGEST * 1000; }
  // 計分
  if (m === 'team') room.score[att.team]++;
  if (m === 'elim' || m === 'team' || m === 'egg' || m === 'hill') att.k += m === 'team' || m === 'elim' ? 1 : 0;
  if (m === 'hunt') att.k += 3;
  if (m === 'glutton') {
    const lead = leader(room);
    const bonus = lead && lead.id === vic.id && vic.k > 0 ? 2 : 1;
    att.k += bonus;
    if (bonus === 2) note(room, `${att.name} 吃掉了第一名 ${vic.name}！得 2 分`);
  }
  emitRoom(room, 'eat', { att: att.id, vic: vic.id, out: !!vic.out });
  // 全滅戰：吃人的人被吃掉 → 牠肚子裡的人全部被救出來
  for (const q of room.players.values()) {
    if (q.heldBy === vic.id && q.out) {
      q.out = false; q.eatenBy = null; q.heldBy = null; q.pos = [vic.pos[0] + (Math.random() - 0.5) * 4, 1, vic.pos[2] + (Math.random() - 0.5) * 4]; q.vel = [0, 0, 0];
      io.to(q.id).emit('respawn', { pos: q.pos });
      note(room, `${q.name} 從 ${vic.name} 的肚子裡被救出來了！`);
    }
  }
}
function leader(room) {
  let best = null;
  for (const p of room.players.values()) if (!best || p.k > best.k) best = p;
  return best && best.k > 0 ? best : null;
}
function canGrab(room, me, vic) {
  if (!vic || vic === me || vic.out || vic.eatenBy || me.out || me.eatenBy) return false;
  if (room.phase !== 'play') return false;
  if (room.M.teams && vic.team === me.team) return false;
  if (room.mode === 'hunt' && me.role === vic.role) return false;
  if (room.mode === 'egg' && room.egg.carrier === me.id) return false;           // 拿著蛋不能抓人
  if (room.grabs.some((g) => g.vic === vic.id || g.vic === me.id || g.att === me.id)) return false;
  const range = room.mode === 'hunt' && me.role === 'hunter' ? HUNTER_RANGE : RANGE;
  if (dist(me.pos, vic.pos) > range + 6 || lineBlocked(mouthOf(me), vic.pos)) return false;
  return true;
}

// ===== 每個模式的回合判定、計分、畫面上方顯示 =====
function hudOf(room) {
  const m = room.mode, segs = [];
  if (m === 'team' || m === 'egg' || m === 'hill') {
    segs.push({ t: `紅隊 ${room.score.red}`, c: 'red' }, { t: `${room.score.blue} 藍隊`, c: 'blue' });
  } else if (m === 'elim') {
    const ar = alive(room).filter((p) => p.team === 'red').length, ab = alive(room).filter((p) => p.team === 'blue').length;
    segs.push({ t: `紅 ${room.wins.red} 勝｜剩 ${ar}`, c: 'red' }, { t: `剩 ${ab}｜${room.wins.blue} 勝 藍`, c: 'blue' });
  } else if (m === 'hunt') {
    if (room.players.size < 2) segs.push({ t: '等待更多玩家加入…', c: '' });
    else segs.push({ t: `第 ${room.round}/${room.M.rounds} 回合`, c: '' }, { t: `獵物剩 ${alive(room).filter((p) => p.role === 'prey').length}`, c: '' });
  } else if (m === 'race') {
    segs.push({ t: `兩圈・${RINGS.length} 個圈圈`, c: '' });
  } else if (m === 'glutton') {
    const l = leader(room); segs.push({ t: l ? `第一名：${l.name} ${l.k} 分` : '還沒有人吃到', c: '' });
  }
  return segs;
}
function endRound(room, title, sub) {
  for (const g of [...room.grabs]) releaseGrab(room, g, null);
  const M = room.M;
  if (M.rounds && room.round < M.rounds && !(room.mode === 'elim' && Math.max(room.wins.red, room.wins.blue) >= 2)) {
    room.phase = 'break'; room.endsAt = Date.now() + ROUND_BREAK * 1000;
    emitRoom(room, 'match', { phase: 'break', title, sub, rows: [] });
  } else finishMatch(room, title, sub);
}
function finishMatch(room, roundTitle, roundSub) {
  for (const g of [...room.grabs]) releaseGrab(room, g, null);
  room.phase = 'results'; room.endsAt = Date.now() + RESULT_TIME * 1000;
  const m = room.mode, ps = [...room.players.values()];
  let title = '', sub = '', rows = [];
  const teamWin = (a, b) => (a === b ? 'tie' : a > b ? 'red' : 'blue');
  if (m === 'team' || m === 'egg' || m === 'hill') {
    const w = teamWin(room.score.red, room.score.blue);
    title = w === 'tie' ? '平手！' : `${TEAM_NAME[w]}獲勝！`; sub = `${room.score.red} : ${room.score.blue}`;
  } else if (m === 'elim') {
    const w = teamWin(room.wins.red, room.wins.blue);
    title = w === 'tie' ? '平手！' : `${TEAM_NAME[w]}獲勝！`; sub = `回合 ${room.wins.red} : ${room.wins.blue}`;
  } else {
    title = roundTitle || '比賽結束'; sub = roundSub || '';
  }
  const label = { team: '吃掉', elim: '吃掉', egg: '搬蛋', hill: '佔領秒數', hunt: '分數', race: '圈圈', glutton: '分數' }[m];
  if (m === 'race') {
    const order = [...room.race.finished.map((id) => room.players.get(id)).filter(Boolean),
      ...ps.filter((p) => !room.race.finished.includes(p.id)).sort((a, b) => b.cp - a.cp)];
    rows = order.map((p, i) => ({ n: `${i + 1}. ${p.name}`, v: room.race.finished.includes(p.id) ? '完成' : `${p.cp}/${RACE_CPS}`, id: p.id }));
    if (room.race.finished.length) title = `${order[0].name} 第一名！`;
    else if (order[0] && order[0].cp > 0) { title = '時間到！'; sub = `${order[0].name} 跑得最遠`; }
    else title = '時間到！';
  } else {
    rows = ps.sort((a, b) => b.k - a.k).map((p) => ({ n: p.name, v: `${p.k}`, team: p.team, id: p.id }));
    // 個人賽：分數最高的人就是冠軍
    if (m === 'glutton' || m === 'hunt') {
      const top = ps[0];
      title = top && top.k > 0 ? (m === 'glutton' ? `${top.name} 是大胃王！` : `${top.name} 拿下最高分！`) : '比賽結束';
      sub = top && top.k > 0 ? `${top.k} 分` : '';
    }
  }
  emitRoom(room, 'match', { phase: 'results', title, sub, label, rows });
}
function modeTick(room, now) {
  const m = room.mode;
  // 搶蛋
  if (m === 'egg' && room.phase === 'play') {
    const egg = room.egg;
    if (egg.carrier) {
      const c = room.players.get(egg.carrier);
      if (!c || c.out || c.eatenBy) { if (c) dropEgg(room, c); else { egg.carrier = null; egg.droppedAt = now; } }
      else {
        egg.pos = [c.pos[0], c.pos[1] + 2.2, c.pos[2]];
        if (hdist(c.pos, [BASES[c.team][0], 0, BASES[c.team][1]]) < BASE_R && c.pos[1] < 6) {
          room.score[c.team]++; c.k++;
          note(room, `${c.name} 把蛋搬回${TEAM_NAME[c.team]}基地！`);
          room.egg = { pos: [...EGG_HOME], carrier: null, droppedAt: 0 };
        }
      }
    } else {
      for (const p of alive(room)) if (dist(p.pos, egg.pos) < 2.6) { egg.carrier = p.id; note(room, `${p.name} 撿到蛋了！`); break; }
      if (!egg.carrier && egg.droppedAt && now - egg.droppedAt > 15000) { room.egg = { pos: [...EGG_HOME], carrier: null, droppedAt: 0 }; note(room, '蛋回到中間了'); }
    }
  }
  // 王者之山
  if (m === 'hill' && room.phase === 'play') {
    const z = room.zone, c = ZONES[z.i];
    if (now >= z.movesAt) { z.i = (z.i + 1) % ZONES.length; z.movesAt = now + ZONE_MOVE * 1000; note(room, '發光區域換位置了！'); }
    const inside = alive(room).filter((p) => Math.hypot(p.pos[0] - c[0], p.pos[2] - c[1]) < ZONE_R && p.pos[1] < 8);
    const teams = new Set(inside.map((p) => p.team));
    z.owner = teams.size === 1 ? [...teams][0] : teams.size > 1 ? 'contest' : null;
    z.acc += TICK;
    if (z.acc >= 1) {
      z.acc -= 1;
      if (z.owner === 'red' || z.owner === 'blue') { room.score[z.owner]++; for (const p of inside) p.k++; }
    }
    if (room.score.red >= 100 || room.score.blue >= 100) finishMatch(room);
  }
  // 全滅戰：一隊全部出局就輸掉這回合
  if (m === 'elim' && room.phase === 'play') {
    const ar = alive(room).filter((p) => p.team === 'red').length, ab = alive(room).filter((p) => p.team === 'blue').length;
    const both = members(room, 'red').length > 0 && members(room, 'blue').length > 0;
    let w = null;
    if (both && ar === 0) w = 'blue'; else if (both && ab === 0) w = 'red';
    else if (now >= room.endsAt) w = ar === ab ? 'tie' : ar > ab ? 'red' : 'blue';
    if (w) {
      if (w !== 'tie') room.wins[w]++;
      endRound(room, w === 'tie' ? '這回合平手' : `${TEAM_NAME[w]}贏下第 ${room.round} 回合`, `回合 ${room.wins.red} : ${room.wins.blue}`);
    }
  }
  // 獵人與獵物：至少要 2 個人；人數夠了但還沒有獵人，就開始新的一回合並分配獵人
  if (m === 'hunt' && room.phase === 'play' && room.players.size >= 2 && !members(room, 'hunter').length) {
    resetRound(room, false); emitRoom(room, 'match', { phase: 'play' }); note(room, '獵人與獵物開始！');
  }
  if (m === 'hunt' && room.phase === 'play' && room.players.size >= 2) {
    const prey = alive(room).filter((p) => p.role === 'prey');
    if (prey.length === 0) endRound(room, '獵人贏了！', '獵物全部被吃光');
    else if (now >= room.endsAt) { for (const p of prey) p.k += 5; endRound(room, '獵物贏了！', `撐到最後的獵物各得 5 分`); }
  }
  // 競速：第一名到終點後 20 秒結束
  if (m === 'race' && room.phase === 'play' && room.race.firstAt && now - room.race.firstAt > 20000) finishMatch(room);
  // 時間到
  if (room.phase === 'play' && now >= room.endsAt && !(m === 'elim' || m === 'hunt')) finishMatch(room);
  // 休息、結算結束
  if (room.phase === 'break' && now >= room.endsAt) { room.round++; resetRound(room, false); emitRoom(room, 'match', { phase: 'play' }); }
  if (room.phase === 'results' && now >= room.endsAt) { resetRound(room, true); emitRoom(room, 'match', { phase: 'play' }); }
}
// 競速：檢查有沒有穿過下一個圈圈（用上一筆到這一筆位置的線段判斷，速度快也不會漏掉）
function raceCheck(room, p) {
  if (room.mode !== 'race' || room.phase !== 'play' || p.cp >= RACE_CPS) { p.lastPos = p.pos; return; }
  const ring = RINGS[p.cp % RINGS.length], a = p.lastPos || p.pos;
  if (segPoint(a, p.pos, ring).d < RING_R) {
    p.cp++; p.k = p.cp;
    if (p.cp >= RACE_CPS) {
      room.race.finished.push(p.id);
      if (!room.race.firstAt) room.race.firstAt = Date.now();
      note(room, `${p.name} 第 ${room.race.finished.length} 個抵達終點！`);
      if (room.race.finished.length === room.players.size) finishMatch(room);
    }
  }
  p.lastPos = p.pos;
}

io.on('connection', (socket) => {
  let room = null, me = null;

  socket.on('join', ({ name, room: code, mode } = {}) => {
    if (room) return;
    if (!MODES[mode]) mode = 'team';
    let rc = cleanRoom(code);
    if (!rc) rc = `大廳-${MODES[mode].name}`;              // 不填代碼：每種模式各有一個公開大廳
    const r = rooms.get(rc) || makeRoom(rc, mode);
    if (r.players.size >= MAX_PLAYERS) return socket.emit('full');
    room = r; socket.join(room.code);
    const team = pickTeam(room);
    me = { id: socket.id, name: cleanName(name), team, role: room.mode === 'hunt' ? 'prey' : null, color: null, pos: [0, 1, 0], vel: [0, 0, 0],
      face: 0, tip: null, tp: null, aim: false, gnd: true, k: 0, deaths: 0, eatenBy: null, out: false, heldBy: null, respawnAt: 0, cp: 0, lastPos: null };
    me.color = pickColor(room, team);
    room.players.set(me.id, me);
    // 中途加入淘汰制的模式：這回合先觀戰
    if ((room.mode === 'elim' || room.mode === 'hunt') && room.phase === 'play' && room.players.size > 2 && Date.now() > room.roundStart + 10000) {
      me.out = true; me.eatenBy = null;
    }
    me.pos = spawnFor(room, me);
    socket.emit('welcome', {
      id: me.id, room: room.code, mode: room.mode, modeName: room.M.name, desc: room.M.desc, team, role: me.role, color: me.color, pos: me.pos,
      out: me.out, map: { eggHome: EGG_HOME, bases: BASES, baseR: BASE_R, zones: ZONES, zoneR: ZONE_R, rings: RINGS, ringR: RING_R, laps: LAPS },
    });
    note(room, `${me.name} 加入了${TEAM_NAME[team] || ''}`);
  });

  socket.on('st', (s = {}) => {
    if (!me || me.eatenBy || me.out) return;
    me.pos = vec(s.p, me.pos); me.vel = vec(s.v, me.vel);
    me.face = num(s.f, me.face); me.gnd = !!s.g; me.aim = !!s.a;
    me.tp = typeof s.tp === 'string' ? s.tp.slice(0, 6) : null;
    me.tip = s.tip ? vec(s.tip, null) : null;
    raceCheck(room, me);
  });

  socket.on('grab', ({ vic: vid } = {}) => {
    if (!me) return;
    const vic = room.players.get(vid);
    // 獵物的舌頭打中正在拉人的獵人：救下同伴（獵物不能吃人）
    if (room.mode === 'hunt' && me.role === 'prey' && vic && vic.role === 'hunter' && !me.out && !me.eatenBy) {
      const held = room.grabs.filter((g) => g.att === vic.id);
      for (const g of held) releaseGrab(room, g, 'rescued');
      if (held.length) { me.k += 1; note(room, `${me.name} 打中獵人，救了同伴！`); }
      return socket.emit('grabDenied', { vic: vid });
    }
    if (!canGrab(room, me, vic)) return socket.emit('grabDenied', { vic: vid });
    startGrab(room, me, vic);
  });

  socket.on('click', () => {
    if (!me) return;
    const g = room.grabs.find((g) => g.att === me.id);
    if (g && me.aim) g.boost = Math.min(MAX_BOOST, g.boost + CLICK_BOOST);
  });

  socket.on('disconnect', () => {
    if (!room || !me) return;
    for (const g of room.grabs.filter((g) => g.att === me.id || g.vic === me.id)) releaseGrab(room, g, null);
    dropEgg(room, me);
    room.players.delete(me.id);
    note(room, `${me.name} 離開了`);
    if (room.players.size === 0) rooms.delete(room.code);
    else if (room.mode === 'hunt' && me.role === 'hunter' && !members(room, 'hunter').length && room.phase === 'play') endRound(room, '獵人離開了', '重新分配獵人');
  });
});

// ===== 遊戲主迴圈 =====
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const g of [...room.grabs]) {
      const att = room.players.get(g.att), vic = room.players.get(g.vic);
      if (!att || !vic || att.eatenBy || vic.eatenBy || att.out || vic.out) { releaseGrab(room, g, null); continue; }
      const anchor = mouthOf(att);
      if (lineBlocked(anchor, vic.pos)) { releaseGrab(room, g, 'snap'); continue; }
      g.boost = Math.max(0, g.boost - BOOST_DECAY * TICK);
      g.L = Math.max(0, Math.min(g.L, dist(anchor, vic.pos) + 0.5) - (att.aim ? PULL_BASE + g.boost : 0) * TICK);
      if (room.mode === 'race') {
        // 競速：只會把對手往回拉一段，不會吃掉
        if (g.L <= EAT_DIST + 1 || now - g.at > 2500) releaseGrab(room, g, 'race');
      } else if (g.L <= EAT_DIST) eat(room, g);
    }
    for (const p of room.players.values()) if (p.eatenBy && !p.out && now >= p.respawnAt) respawn(room, p);
    modeTick(room, now);
    if (++room.tick % SEND_EVERY) continue;
    const r1 = (n) => Math.round(n * 100) / 100;
    const lead = room.mode === 'glutton' ? leader(room) : null;
    emitRoom(room, 'snap', {
      t: now, left: Math.max(0, room.endsAt - now), phase: room.phase, hud: hudOf(room),
      players: [...room.players.values()].map((p) => ({
        id: p.id, n: p.name, team: p.team, role: p.role, c: p.color, p: p.pos.map(r1), v: p.vel.map(r1), f: r1(p.face),
        g: p.gnd, tp: p.tp, tip: p.tip && p.tip.map(r1), e: p.eatenBy, o: p.out, h: p.heldBy, k: p.k, d: p.deaths, cp: p.cp,
      })),
      grabs: room.grabs.map((g) => ({ att: g.att, vic: g.vic, L: r1(g.L), b: r1(g.boost) })),
      egg: room.egg && { p: room.egg.pos.map(r1), c: room.egg.carrier },
      zone: room.zone && { i: room.zone.i, o: room.zone.owner, m: Math.max(0, room.zone.movesAt - now) },
      lead: lead && lead.id,
    });
  }
}, TICK * 1000);

const PORT = process.env.PORT || 3000;
if (require.main === module) server.listen(PORT, () => console.log(`舌戰伺服器已啟動：http://localhost:${PORT}`));
module.exports = { trunks, rocks, RINGS, ZONES, BASES, server };
