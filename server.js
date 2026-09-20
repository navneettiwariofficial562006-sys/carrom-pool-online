const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const TURN_TIME = 30000;

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function roomCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function newRoom(id) {
  return {
    id,
    players: [],
    names: { 1: "Player 1", 2: "Player 2" },
    scores: { 1: 0, 2: 0 },
    turn: 1,
    paused: false,
    gameOver: false,
    turnStartedAt: Date.now(),
    rematch: new Set()
  };
}

function state(room) {
  return {
    roomId: room.id,
    players: room.players.map(p => ({ id: p.id, player: p.player, name: p.name })),
    names: room.names,
    scores: room.scores,
    turn: room.turn,
    paused: room.paused,
    gameOver: room.gameOver,
    turnStartedAt: room.turnStartedAt
  };
}

function sendState(room) {
  io.to(room.id).emit("state", state(room));
}

function opponentOf(room, player) {
  return player === 1 ? 2 : 1;
}

function finishRoom(room, winner, reason) {
  room.gameOver = true;
  room.paused = false;
  io.to(room.id).emit("gameOver", {
    winner,
    reason,
    scores: room.scores,
    names: room.names
  });
  sendState(room);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name }) => {
    const id = roomCode();
    const room = newRoom(id);
    room.players.push({ id: socket.id, player: 1, name: String(name || "Player 1").slice(0, 18) });
    room.names[1] = room.players[0].name;
    rooms.set(id, room);
    socket.join(id);
    socket.data.roomId = id;
    socket.data.player = 1;

    socket.emit("roomCreated", { roomId: id, player: 1 });
    sendState(room);
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    const id = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(id);

    if (!room) return socket.emit("errorMessage", "Room not found.");
    if (room.players.length >= 2) return socket.emit("errorMessage", "Room is full.");
    if (room.gameOver) return socket.emit("errorMessage", "That room has finished.");

    room.players.push({ id: socket.id, player: 2, name: String(name || "Player 2").slice(0, 18) });
    room.names[2] = room.players[1].name;

    socket.join(id);
    socket.data.roomId = id;
    socket.data.player = 2;

    socket.emit("joinedRoom", { roomId: id, player: 2 });
    io.to(id).emit("gameReady", state(room));
    sendState(room);
  });

  socket.on("shot", data => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameOver || room.paused) return;
    if (socket.data.player !== room.turn) return;

    const x = Number(data.x);
    const angle = Number(data.angle);
    const power = Number(data.power);

    if (![x, angle, power].every(Number.isFinite)) return;

    io.to(room.id).emit("remoteShot", {
      shooter: socket.data.player,
      x: Math.max(85, Math.min(635, x)),
      angle,
      power: Math.max(0.12, Math.min(1, power)),
      shotId: String(data.shotId || Date.now())
    });
  });

  socket.on("shotResult", ({ points = 0, foul = false }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameOver) return;
    if (socket.data.player !== room.turn) return;

    points = Math.max(0, Math.floor(Number(points) || 0));
    foul = Boolean(foul);

    if (foul) room.scores[room.turn] = Math.max(0, room.scores[room.turn] - 1);
    room.scores[room.turn] += points;

    if (room.scores[room.turn] >= 10) {
      finishRoom(room, room.turn, "score");
      return;
    }

    const keepTurn = points > 0 && !foul;
    if (!keepTurn) room.turn = opponentOf(room, room.turn);

    room.turnStartedAt = Date.now();
    sendState(room);
  });

  socket.on("pauseGame", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameOver) return;
    room.paused = true;
    io.to(room.id).emit("paused");
  });

  socket.on("resumeGame", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameOver) return;
    room.paused = false;
    room.turnStartedAt = Date.now();
    io.to(room.id).emit("resumed", { turnStartedAt: room.turnStartedAt });
  });

  socket.on("requestRematch", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.players.length < 2) return;
    room.rematch.add(socket.id);

    if (room.rematch.size === 2) {
      room.rematch.clear();
      room.scores = { 1: 0, 2: 0 };
      room.turn = 1;
      room.gameOver = false;
      room.paused = false;
      room.turnStartedAt = Date.now();
      io.to(room.id).emit("rematchStart", state(room));
    }
  });

  socket.on("leaveRoom", () => leave(socket));

  socket.on("disconnect", () => leave(socket));

  function leave(socketRef) {
    const roomId = socketRef.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const leavingPlayer = socketRef.data.player;
    const other = room.players.find(p => p.id !== socketRef.id);

    room.players = room.players.filter(p => p.id !== socketRef.id);

    if (other && !room.gameOver) {
      finishRoom(room, other.player, "opponent-left");
      io.to(other.id).emit("opponentLeft");
    } else if (room.players.length === 0) {
      rooms.delete(roomId);
    }
  }
});

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (room.gameOver || room.paused || room.players.length < 2) continue;

    if (now - room.turnStartedAt >= TURN_TIME) {
      finishRoom(room, opponentOf(room, room.turn), "timeout");
    }
  }
}, 500);

server.listen(PORT, () => {
  console.log(`Carrom Pool running at http://localhost:${PORT}`);
});
