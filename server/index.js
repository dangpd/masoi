// server/index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

/**
 * =========================
 * CONFIG
 * =========================
 * Server tự chạy theo timer này (nguồn sự thật).
 * Client chỉ hiển thị timer.
 */
const TIMERS = {
  WOLF_INTRO_MS: 10_000,     // đêm 1: sói mở mắt nhìn nhau
  WOLF_BITE_MS: 30_000,      // sói chọn cắn
  GUARD_MS: 20_000,          // bảo vệ chọn
  SEER_MS: 20_000,           // tiên tri soi
  WITCH_MS: 25_000,          // phù thủy cứu/độc
  DISCUSS_MS: 120_000,       // bàn bạc sau đêm
  VOTE_MS: 60_000            // vote
};

// Rooms in memory
const rooms = {};

// =========================
// Helpers
// =========================
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId);
}

function getPlayerName(room, socketId) {
  const p = getPlayer(room, socketId);
  return p ? p.name : "(Ẩn)";
}

function alivePlayers(room) {
  return room.players.filter(p => p.alive);
}

function aliveIds(room) {
  return alivePlayers(room).map(p => p.id);
}

function isHost(room, socketId) {
  return room.hostId === socketId;
}

function isAlive(room, socketId) {
  return !!room.players.find(p => p.id === socketId && p.alive);
}

function roleOf(room, socketId) {
  return room.players.find(p => p.id === socketId)?.role || null;
}

function simpleRoom(room) {
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    phase: room.phase,           // waiting | night | discuss | vote | end
    nightStep: room.nightStep,   // wolf_intro | wolf_bite | guard | seer | witch | resolve | null
    logs: room.logs.slice(-200),
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive
    }))
  };
}

/**
 * Role assignment (4-10)
 * roles: Sói, Dân làng, Tiên tri, Bảo vệ, Phù thủy
 */
function rolesForCount(n) {
  // cân bằng dễ chơi
  // 4: 1W, 1Seer, 2Vill
  // 5: 1W, 1Seer, 1Guard, 2Vill
  // 6: 2W, 1Seer, 1Guard, 2Vill
  // 7: 2W, 1Seer, 1Guard, 1Witch, 2Vill
  // 8: 2W, 1Seer, 1Guard, 1Witch, 3Vill
  // 9: 2W, 1Seer, 1Guard, 1Witch, 4Vill
  // 10:3W, 1Seer, 1Guard, 1Witch, 4Vill
  if (n === 4)  return ["Sói", "Tiên tri", "Dân làng", "Dân làng"];
  if (n === 5)  return ["Sói", "Tiên tri", "Bảo vệ", "Dân làng", "Dân làng"];
  if (n === 6)  return ["Sói", "Sói", "Tiên tri", "Bảo vệ", "Dân làng", "Dân làng"];
  if (n === 7)  return ["Sói", "Sói", "Tiên tri", "Bảo vệ", "Phù thủy", "Dân làng", "Dân làng"];
  if (n === 8)  return ["Sói", "Sói", "Tiên tri", "Bảo vệ", "Phù thủy", "Dân làng", "Dân làng", "Dân làng"];
  if (n === 9)  return ["Sói", "Sói", "Tiên tri", "Bảo vệ", "Phù thủy", "Dân làng", "Dân làng", "Dân làng", "Dân làng"];
  if (n === 10) return ["Sói", "Sói", "Sói", "Tiên tri", "Bảo vệ", "Phù thủy", "Dân làng", "Dân làng", "Dân làng", "Dân làng"];
  // fallback
  return Array.from({ length: n }, () => "Dân làng");
}

function assignRoles(players) {
  const roles = shuffle(rolesForCount(players.length));
  return players.map((p, i) => ({
    ...p,
    role: roles[i],
    alive: true
  }));
}

// =========================
// Timer utilities (server side)
// =========================
function clearRoomTimers(room) {
  if (room.timer?.timeoutId) clearTimeout(room.timer.timeoutId);
  room.timer.timeoutId = null;
  room.timer.phaseEndsAt = null;
}

function startRoomTimeout(room, ms, fn) {
  clearRoomTimers(room);
  room.timer.phaseEndsAt = Date.now() + ms;
  room.timer.timeoutId = setTimeout(() => {
    clearRoomTimers(room);
    fn();
  }, ms);
}

// =========================
// Night step machine
// =========================
function emitRoom(room) {
  io.to(room.roomId).emit("phaseChange", simpleRoom(room));
}

/**
 * Prompt only to players of a role (alive only)
 */
function promptRole(room, role, payload) {
  room.players.forEach(p => {
    if (p.alive && p.role === role) {
      io.to(p.id).emit("promptAction", payload);
    }
  });
}

function wolfIds(room) {
  return room.players.filter(p => p.alive && p.role === "Sói").map(p => p.id);
}

function beginNight(room) {
  if (room.phase === "end") return;

  room.phase = "night";
  room.nightActions = {
    wolvesTarget: null,
    guardTarget: null,
    seerTarget: null,
    witch: { save: false, killTarget: null, hasSave: room.nightActions?.witch?.hasSave ?? true, hasKill: room.nightActions?.witch?.hasKill ?? true }
  };

  room.wolfVotes = {}; // socketId -> targetId (for wolves)
  room.logs.push("🌙 Đêm bắt đầu. Tất cả đi ngủ.");
  room.nightStep = "wolf_intro";
  emitRoom(room);

  const wolves = wolfIds(room);

  // Đêm 1: Sói mở mắt nhìn nhau (intro chỉ 1 lần)
  if (!room.nightMeta.wolfIntroDone && wolves.length > 0) {
    // gửi danh sách sói cho các sói biết mặt nhau
    const wolfList = room.players
      .filter(p => p.alive && p.role === "Sói")
      .map(p => ({ id: p.id, name: p.name }));

    promptRole(room, "Sói", { type: "wolf_intro", wolfList });
    room.logs.push("🐺 Sói mở mắt để nhận mặt nhau (đêm đầu tiên).");
    emitRoom(room);

    startRoomTimeout(room, TIMERS.WOLF_INTRO_MS, () => {
      room.nightMeta.wolfIntroDone = true;
      beginWolfBite(room);
    });
    return;
  }

  // Nếu không cần intro
  beginWolfBite(room);
}

function beginWolfBite(room) {
  if (room.phase === "end") return;
  room.nightStep = "wolf_bite";
  room.logs.push("🐺 Sói chọn người cắn.");
  emitRoom(room);

  const candidates = alivePlayers(room).map(p => ({ id: p.id, name: p.name }));
  promptRole(room, "Sói", { type: "wolf_bite", candidates });

  startRoomTimeout(room, TIMERS.WOLF_BITE_MS, () => {
    // nếu sói chưa vote, coi như bỏ lượt
    finalizeWolfTarget(room);
    beginGuard(room);
  });
}

function finalizeWolfTarget(room) {
  // chọn theo đa số vote của Sói
  const wolves = wolfIds(room);
  if (wolves.length === 0) {
    room.nightActions.wolvesTarget = null;
    return;
  }

  const counts = new Map();
  for (const wid of wolves) {
    const voted = room.wolfVotes[wid];
    if (!voted) continue;
    counts.set(voted, (counts.get(voted) || 0) + 1);
  }

  let bestId = null;
  let bestCt = 0;
  for (const [id, ct] of counts.entries()) {
    if (ct > bestCt) {
      bestCt = ct;
      bestId = id;
    }
  }

  room.nightActions.wolvesTarget = bestId;
}

function beginGuard(room) {
  if (room.phase === "end") return;
  room.nightStep = "guard";

  const hasGuard = alivePlayers(room).some(p => p.role === "Bảo vệ");
  if (!hasGuard) {
    room.logs.push("🛡️ Không có Bảo vệ, bỏ qua.");
    emitRoom(room);
    return beginSeer(room);
  }

  room.logs.push("🛡️ Bảo vệ chọn người bảo vệ.");
  emitRoom(room);

  const candidates = alivePlayers(room).map(p => ({ id: p.id, name: p.name }));
  promptRole(room, "Bảo vệ", { type: "guard_protect", candidates });

  startRoomTimeout(room, TIMERS.GUARD_MS, () => beginSeer(room));
}

function beginSeer(room) {
  if (room.phase === "end") return;
  room.nightStep = "seer";

  const hasSeer = alivePlayers(room).some(p => p.role === "Tiên tri");
  if (!hasSeer) {
    room.logs.push("🔮 Không có Tiên tri, bỏ qua.");
    emitRoom(room);
    return beginWitch(room);
  }

  room.logs.push("🔮 Tiên tri chọn người soi.");
  emitRoom(room);

  const candidates = alivePlayers(room).map(p => ({ id: p.id, name: p.name }));
  promptRole(room, "Tiên tri", { type: "seer_view", candidates });

  startRoomTimeout(room, TIMERS.SEER_MS, () => beginWitch(room));
}

function beginWitch(room) {
  if (room.phase === "end") return;
  room.nightStep = "witch";

  const hasWitch = alivePlayers(room).some(p => p.role === "Phù thủy");
  if (!hasWitch) {
    room.logs.push("🧪 Không có Phù thủy, bỏ qua.");
    emitRoom(room);
    return resolveNight(room);
  }

  const wolfTarget = room.nightActions.wolvesTarget;
  const victimName = wolfTarget ? getPlayerName(room, wolfTarget) : null;

  room.logs.push("🧪 Phù thủy thức dậy (có thể cứu hoặc đầu độc).");
  emitRoom(room);

  // chỉ gửi cho phù thủy: thông tin ai bị cắn (nếu có)
  promptRole(room, "Phù thủy", {
    type: "witch",
    wolfVictim: wolfTarget ? { id: wolfTarget, name: victimName } : null,
    hasSave: !!room.nightActions.witch.hasSave,
    hasKill: !!room.nightActions.witch.hasKill,
    candidates: alivePlayers(room).map(p => ({ id: p.id, name: p.name }))
  });

  startRoomTimeout(room, TIMERS.WITCH_MS, () => resolveNight(room));
}

function resolveNight(room) {
  if (room.phase === "end") return;
  room.nightStep = "resolve";

  const deadIds = new Set();

  // Sói cắn
  let wolfTarget = room.nightActions.wolvesTarget;

  // Bảo vệ
  const guardTarget = room.nightActions.guardTarget;
  if (wolfTarget && guardTarget && wolfTarget === guardTarget) {
    wolfTarget = null; // được bảo vệ
  }

  // Phù thủy cứu
  if (wolfTarget && room.nightActions.witch.save && room.nightActions.witch.hasSave === false) {
    // save đã dùng
  }
  if (wolfTarget && room.nightActions.witch.save === true) {
    // cứu người bị cắn
    wolfTarget = null;
  }

  if (wolfTarget) deadIds.add(wolfTarget);

  // Phù thủy độc
  const killTarget = room.nightActions.witch.killTarget;
  if (killTarget) deadIds.add(killTarget);

  // Apply deaths
  room.players.forEach(p => {
    if (deadIds.has(p.id)) p.alive = false;
  });

  if (deadIds.size === 0) {
    room.logs.push("🌙 Kết thúc đêm: Không ai chết.");
  } else {
    const names = [...deadIds].map(id => getPlayerName(room, id)).join(", ");
    room.logs.push(`🌙 Kết thúc đêm: ${names} đã chết.`);
  }

  emitRoom(room);

  // Endgame?
  if (checkGameOver(room)) return;

  // sang discuss
  beginDiscuss(room);
}

function beginDiscuss(room) {
  if (room.phase === "end") return;
  room.phase = "discuss";
  room.nightStep = null;
  room.logs.push("☀️ Trời sáng. Bắt đầu 2 phút bàn bạc.");
  emitRoom(room);

  startRoomTimeout(room, TIMERS.DISCUSS_MS, () => beginVote(room));
}

function beginVote(room) {
  if (room.phase === "end") return;
  room.phase = "vote";
  room.nightStep = null;
  room.votes = {}; // voterId -> targetId
  room.logs.push("🗳️ Bắt đầu bỏ phiếu!");
  emitRoom(room);

  startRoomTimeout(room, TIMERS.VOTE_MS, () => resolveVote(room));
}

function resolveVote(room) {
  if (room.phase === "end") return;

  const alive = alivePlayers(room);
  const counts = new Map();

  for (const voter of alive) {
    const voted = room.votes[voter.id];
    if (!voted) continue;
    counts.set(voted, (counts.get(voted) || 0) + 1);
  }

  // tìm max
  let outId = null;
  let best = 0;
  for (const [id, ct] of counts.entries()) {
    if (ct > best) {
      best = ct;
      outId = id;
    }
  }

  if (outId) {
    const p = getPlayer(room, outId);
    if (p) p.alive = false;
    room.logs.push(`🪢 Kết quả vote: ${getPlayerName(room, outId)} bị treo cổ.`);
  } else {
    room.logs.push("🪢 Kết quả vote: Không ai bị treo cổ (mọi người không vote hoặc phiếu rải).");
  }

  emitRoom(room);

  if (checkGameOver(room)) return;

  // quay lại đêm
  beginNight(room);
}

function checkGameOver(room) {
  const alive = alivePlayers(room);
  const wolves = alive.filter(p => p.role === "Sói").length;
  const villagers = alive.length - wolves;

  if (wolves === 0) {
    room.phase = "end";
    room.logs.push("🏆 Dân làng thắng! (Tất cả Sói đã chết)");
    emitRoom(room);
    io.to(room.roomId).emit("gameEnd", { winner: "Dân làng", detail: "Tất cả Sói đã bị loại." });
    return true;
  }
  if (wolves >= villagers && alive.length > 0) {
    room.phase = "end";
    room.logs.push("🏆 Sói thắng! (Sói đã chiếm ưu thế)");
    emitRoom(room);
    io.to(room.roomId).emit("gameEnd", { winner: "Sói", detail: "Sói đã chiếm ưu thế (sói >= dân còn sống)." });
    return true;
  }
  return false;
}

// =========================
// Socket handlers
// =========================
io.on("connection", (socket) => {
  // Create room
  socket.on("createRoom", ({ playerName }, cb) => {
    const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();

    rooms[roomId] = {
      roomId,
      hostId: socket.id,
      players: [{ id: socket.id, name: String(playerName || "Player").slice(0, 20), alive: true, role: null }],
      phase: "waiting",
      nightStep: null,
      logs: [],
      votes: {},
      wolfVotes: {},
      nightActions: {
        wolvesTarget: null,
        guardTarget: null,
        seerTarget: null,
        witch: { save: false, killTarget: null, hasSave: true, hasKill: true }
      },
      nightMeta: { wolfIntroDone: false },
      timer: { timeoutId: null, phaseEndsAt: null }
    };

    socket.join(roomId);
    cb && cb({ success: true, roomId });

    io.to(roomId).emit("roomUpdate", simpleRoom(rooms[roomId]));
  });

  // Join room
  socket.on("joinRoom", ({ roomId, playerName }, cb) => {
    roomId = String(roomId || "").toUpperCase();
    const room = rooms[roomId];
    if (!room) return cb && cb({ success: false, msg: "Phòng không tồn tại" });
    if (room.phase !== "waiting") return cb && cb({ success: false, msg: "Game đã bắt đầu" });
    if (room.players.length >= 10) return cb && cb({ success: false, msg: "Phòng đã đầy" });

    room.players.push({ id: socket.id, name: String(playerName || "Player").slice(0, 20), alive: true, role: null });
    socket.join(roomId);

    cb && cb({ success: true });
    io.to(roomId).emit("roomUpdate", simpleRoom(room));
  });

  // Start game (host)
  socket.on("startGame", ({ roomId }) => {
    roomId = String(roomId || "").toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (!isHost(room, socket.id)) return;
    if (room.phase !== "waiting") return;

    if (room.players.length < 4 || room.players.length > 10) {
      io.to(socket.id).emit("error", "Cần 4 đến 10 người để bắt đầu.");
      return;
    }

    room.players = assignRoles(room.players);
    room.logs.push("🎮 Game bắt đầu! Mỗi người đã nhận vai trò bí mật.");

    // gửi role riêng cho từng người
    room.players.forEach(p => {
      io.to(p.id).emit("yourRole", { role: p.role, roomData: simpleRoom(room) });
    });

    io.to(roomId).emit("gameStarted", simpleRoom(room));

    // bắt đầu đêm
    beginNight(room);
  });

  // Chat
  socket.on("sendMessage", ({ roomId, message }) => {
    roomId = String(roomId || "").toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    const p = getPlayer(room, socket.id);
    if (!p) return;

    io.to(roomId).emit("receiveMessage", {
      name: p.name,
      message: String(message || "").slice(0, 500)
    });
  });

  /**
   * Wolf vote target (only in wolf_bite step)
   */
  socket.on("wolfBite", ({ roomId, targetId }) => {
    roomId = String(roomId || "").toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (room.phase !== "night" || room.nightStep !== "wolf_bite") return;
    if (!isAlive(room, socket.id)) return;
    if (roleOf(room, socket.id) !== "Sói") return;
    if (!isAlive(room, targetId)) return;

    room.wolfVotes[socket.id] = targetId;
    io.to(socket.id).emit("actionConfirm", "🐺 Đã chọn mục tiêu.");

    // Nếu tất cả sói đã vote, chốt sớm
    const wolves = wolfIds(room);
    const votedAll = wolves.every(wid => !!room.wolfVotes[wid]);
    if (votedAll) {
      finalizeWolfTarget(room);
      clearRoomTimers(room);
      beginGuard(room);
    }
  });

  // Guard protect
  socket.on("guardProtect", ({ roomId, targetId }) => {
    roomId = String(roomId || "").toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (room.phase !== "night" || room.nightStep !== "guard") return;
    if (!isAlive(room, socket.id)) return;
    if (roleOf(room, socket.id) !== "Bảo vệ") return;
    if (!isAlive(room, targetId)) return;

    room.nightActions.guardTarget = targetId;
    io.to(socket.id).emit("actionConfirm", "🛡️ Đã chọn bảo vệ.");
    // chốt sớm bước
    clearRoomTimers(room);
    beginSeer(room);
  });

  // Seer view
  socket.on("seerView", ({ roomId, targetId }) => {
    roomId = String(roomId || "").toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (room.phase !== "night" || room.nightStep !== "seer") return;
    if (!isAlive(room, socket.id)) return;
    if (roleOf(room, socket.id) !== "Tiên tri") return;
    if (!isAlive(room, targetId)) return;

    room.nightActions.seerTarget = targetId;
    const target = getPlayer(room, targetId);
    const result = target?.role === "Sói" ? "Sói" : "Không phải Sói";
    io.to(socket.id).emit("seerResult", { name: target?.name || "(?)", role: result });

    io.to(socket.id).emit("actionConfirm", "🔮 Đã soi.");
    clearRoomTimers(room);
    beginWitch(room);
  });

  // Witch action
  socket.on("witchAction", ({ roomId, save, killId }) => {
    roomId = String(roomId || "").toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (room.phase !== "night" || room.nightStep !== "witch") return;
    if (!isAlive(room, socket.id)) return;
    if (roleOf(room, socket.id) !== "Phù thủy") return;

    // Save: chỉ có ý nghĩa nếu có người bị cắn
    if (save === true && room.nightActions.witch.hasSave) {
      room.nightActions.witch.save = true;
      room.nightActions.witch.hasSave = false;
    }

    if (killId && room.nightActions.witch.hasKill && isAlive(room, killId)) {
      room.nightActions.witch.killTarget = killId;
      room.nightActions.witch.hasKill = false;
    }

    io.to(socket.id).emit("actionConfirm", "🧪 Đã chốt hành động phù thủy.");
    clearRoomTimers(room);
    resolveNight(room);
  });

  // Skip discuss (host only)
  socket.on("skipDiscuss", ({ roomId }) => {
    roomId = String(roomId || "").toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (!isHost(room, socket.id)) return;
    if (room.phase !== "discuss") return;

    room.logs.push("⏭️ Host đã skip bàn bạc, chuyển sang vote.");
    clearRoomTimers(room);
    beginVote(room);
  });

  // Vote (phase vote)
  socket.on("dayVote", ({ roomId, voteForId }) => {
    roomId = String(roomId || "").toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (room.phase !== "vote") return;
    if (!isAlive(room, socket.id)) return;

    // voteForId có thể null => bỏ phiếu trắng
    if (voteForId && !isAlive(room, voteForId)) return;

    room.votes[socket.id] = voteForId || null;
    io.to(socket.id).emit("actionConfirm", "🗳️ Đã vote.");
  });

  // Disconnect: remove from room
  socket.on("disconnect", () => {
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);

        // nếu host rời, chuyển host cho người đầu tiên
        if (room.hostId === socket.id) {
          room.hostId = room.players[0]?.id || null;
          if (room.hostId) room.logs.push("👑 Host đã rời phòng, host mới đã được chuyển.");
        }

        io.to(roomId).emit(room.phase === "waiting" ? "roomUpdate" : "phaseChange", simpleRoom(room));

        if (room.players.length === 0) {
          clearRoomTimers(room);
          delete rooms[roomId];
        }
      }
    });
  });
});

// Health routes
app.get("/", (req, res) => res.send("Ma Sói Server Running"));
app.get("/rooms", (req, res) => {
  res.json(Object.values(rooms).map(r => ({
    roomId: r.roomId,
    phase: r.phase,
    players: r.players.length
  })));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("🐺 Server running on port", PORT));