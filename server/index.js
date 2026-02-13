const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {};

function shuffle(arr) {
  let array = arr.slice();
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function assignRoles(players) {
  let roles;
  switch (players.length) {
    case 7: roles = ['Sói','Sói','Tiên tri','Bảo vệ','Phù thủy','Dân','Dân']; break;
    case 8: roles = ['Sói','Sói','Tiên tri','Bảo vệ','Phù thủy','Dân','Dân','Dân']; break;
    case 9: roles = ['Sói','Sói','Tiên tri','Bảo vệ','Phù thủy','Dân','Dân','Dân','Dân']; break;
    case 10: roles = ['Sói','Sói','Sói','Tiên tri','Bảo vệ','Phù thủy','Dân','Dân','Dân','Dân']; break;
    default: roles = players.map(()=>'Dân');
  }
  const assigned = shuffle(roles);
  return players.map((p, idx) => ({ ...p, role: assigned[idx], alive: true }));
}

function getPlayerName(room, id) {
  const p = room.players.find(p=>p.id === id);
  return p ? p.name : '(Ẩn)';
}

function simpleRoom(room) {
  return {
    roomId: room.roomId,
    players: room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive })),
    logs: room.logs,
    phase: room.phase
  };
}

function checkGameOver(roomId) {
  let room = rooms[roomId];
  const alivePlayers = room.players.filter(p=>p.alive);
  const wolves = alivePlayers.filter(p=>p.role === 'Sói').length;
  const villagers = alivePlayers.length - wolves;

  if (wolves === 0) {
    io.to(roomId).emit('gameEnd', { winner: 'Dân làng', detail: 'Toàn bộ sói đã bị loại!' });
    room.phase = 'end';
  } else if (wolves >= villagers) {
    io.to(roomId).emit('gameEnd', { winner: 'Sói', detail: 'Số sói đã đủ chiếm ưu thế!' });
    room.phase = 'end';
  }
}

function resolveNight(roomId) {
  let room = rooms[roomId];
  if (!room) return;
  let { wolves, guard, witch } = room.nightActions;
  let dead = [];

  let wolfTarget = wolves;
  if (wolfTarget && wolfTarget === guard) wolfTarget = null;
  if (wolfTarget && witch.save && wolfTarget === witch.save) wolfTarget = null;
  if (wolfTarget) dead.push(wolfTarget);
  if (witch.kill) dead.push(witch.kill);
  dead = [...new Set(dead)];

  room.players.forEach(p => {
    if (dead.includes(p.id)) p.alive = false;
  });

  room.logs.push(dead.length
    ? `🌙 Đêm qua: ${dead.map(id=>getPlayerName(room, id)).join(', ')} đã ra đi`
    : `🌙 Đêm qua mọi người đều an toàn!`);

  room.nightActions = { 
    wolves: null, guard: null, seer: null, 
    witch: { save: null, kill: null, hasSave: room.nightActions.witch.hasSave, hasKill: room.nightActions.witch.hasKill } 
  };
  room.phase = 'day';
  room.votes = {};
  io.to(roomId).emit('phaseChange', simpleRoom(room));
  checkGameOver(roomId);
}

function resolveVote(roomId) {
  let room = rooms[roomId];
  let counter = {};
  Object.values(room.votes).forEach(id=>counter[id] = (counter[id]||0)+1);
  let max = 0, outId = null;
  Object.entries(counter).forEach(([id, ct]) => {
    if (ct > max) { max = ct; outId = id; }
  });
  if (outId) {
    let p = room.players.find(p=>p.id === outId);
    if(p) p.alive = false;
    room.logs.push(`☀️ ${getPlayerName(room, outId)} đã bị treo cổ!`);
  } else {
    room.logs.push('☀️ Không ai bị treo cổ!');
  }
  room.votes = {};
  room.phase = 'night';
  room.nightActions = { 
    wolves: null, guard: null, seer: null, 
    witch: { save: null, kill: null, hasSave: room.nightActions.witch.hasSave, hasKill: room.nightActions.witch.hasKill } 
  };
  io.to(roomId).emit('phaseChange', simpleRoom(room));
  checkGameOver(roomId);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('createRoom', ({ playerName }, cb) => {
    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
    rooms[roomId] = { 
      roomId,
      players: [{ id: socket.id, name: playerName, alive: true, role: null }],
      phase: 'waiting',
      logs: [],
      votes: {},
      nightActions: { wolves: null, guard: null, seer: null, witch: { save: null, kill: null, hasSave: true, hasKill: true } }
    };
    socket.join(roomId);
    cb({ success: true, roomId });
    io.to(roomId).emit('roomUpdate', simpleRoom(rooms[roomId]));
  });

  socket.on('joinRoom', ({ roomId, playerName }, cb) => {
    if (!rooms[roomId]) return cb({ success: false, msg: 'Phòng không tồn tại' });
    if (rooms[roomId].phase !== 'waiting') return cb({ success: false, msg: 'Game đã bắt đầu' });
    if (rooms[roomId].players.length >= 10) return cb({ success: false, msg: 'Phòng đã đầy' });
    rooms[roomId].players.push({ id: socket.id, name: playerName, alive: true, role: null });
    socket.join(roomId);
    cb({ success: true });
    io.to(roomId).emit('roomUpdate', simpleRoom(rooms[roomId]));
  });

  socket.on('sendMessage', ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p=>p.id === socket.id);
    if (!player) return;
    io.to(roomId).emit('receiveMessage', { name: player.name, message });
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'waiting') return;
    if (room.players.length < 7 || room.players.length > 10) {
      io.to(socket.id).emit('error', 'Cần 7-10 người chơi');
      return;
    }
    room.phase = 'night';
    room.players = assignRoles(room.players);
    room.logs.push('🎮 Game bắt đầu! Đêm đầu tiên...');
    room.players.forEach(p => {
      io.to(p.id).emit('yourRole', { role: p.role, roomData: simpleRoom(room) });
    });
    io.to(roomId).emit('gameStarted', simpleRoom(room));
  });

  socket.on('wolfBite', ({ roomId, targetId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'night') return;
    room.nightActions.wolves = targetId;
    io.to(socket.id).emit('actionConfirm', 'Đã chọn mục tiêu');
  });

  socket.on('guardProtect', ({ roomId, targetId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'night') return;
    room.nightActions.guard = targetId;
    io.to(socket.id).emit('actionConfirm', 'Đã bảo vệ');
  });

  socket.on('seerView', ({ roomId, targetId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'night') return;
    const player = room.players.find(p=>p.id === targetId);
    const role = player ? player.role : null;
    io.to(socket.id).emit('seerResult', { name: player.name, role });
    room.nightActions.seer = targetId;
  });

  socket.on('witchAction', ({ roomId, saveId, killId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'night') return;
    let wa = room.nightActions.witch;
    if (saveId && wa.hasSave) { wa.save = saveId; wa.hasSave = false; }
    if (killId && wa.hasKill) { wa.kill = killId; wa.hasKill = false; }
    io.to(socket.id).emit('actionConfirm', 'Đã sử dụng thuốc');
  });

  socket.on('endNight', ({ roomId }) => {
    resolveNight(roomId);
  });

  socket.on('dayVote', ({ roomId, voteForId }) => {
    let room = rooms[roomId];
    if (!room || room.phase !== 'day') return;
    const voter = room.players.find(p=>p.id === socket.id);
    if (!voter || !voter.alive) return;
    room.votes[socket.id] = voteForId;
    io.to(roomId).emit('voteUpdate', { voterId: socket.id, voteForId });
    const aliveVoters = room.players.filter(p=>p.alive).length;
    if (Object.keys(room.votes).length === aliveVoters) {
      setTimeout(() => resolveVote(roomId), 2000);
    }
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx > -1) {
        room.players.splice(idx, 1);
        io.to(roomId).emit('roomUpdate', simpleRoom(room));
        if (room.players.length === 0) delete rooms[roomId];
      }
    });
  });
});

app.get('/', (req, res) => res.send('Ma Sói Server Running'));
app.get('/rooms', (req, res) => {
  res.json(Object.values(rooms).map(r => ({ roomId: r.roomId, numPlayers: r.players.length, phase: r.phase })));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🐺 Server running on port ${PORT}`));