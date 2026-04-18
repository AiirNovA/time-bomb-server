import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3001;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const MAX_ROUNDS = 4;

const rooms = new Map();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.static(path.resolve(__dirname, "../client/dist")));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const randomId = () => Math.random().toString(36).slice(2, 10);

const shuffle = (items) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

// --- LOGIQUE DE JEU ---

const createDynamicDeck = (playerCount) => {
  const totalCards = playerCount * 5; 
  const goldenCables = playerCount; 
  const bigBen = 1;
  const neutrals = totalCards - goldenCables - bigBen;

  const deck = [];
  for (let i = 0; i < neutrals; i++) deck.push({ id: randomId(), type: "neutral_cable", isRevealed: false });
  for (let i = 0; i < goldenCables; i++) deck.push({ id: randomId(), type: "golden_cable", isRevealed: false });
  deck.push({ id: randomId(), type: "big_ben", isRevealed: false });
  return shuffle(deck);
};

const emitRoomState = (room) => {
  room.players.forEach((recipient) => {
    if (!recipient.socketId) return;

    const safePlayers = room.players.map(pl => ({
      id: pl.id,
      name: pl.name,
      connected: pl.connected,
      wires: pl.wires.map(w => ({
        id: w.id,
        type: (w.isRevealed || pl.id === recipient.id || room.game.status === "ended") ? w.type : "hidden",
        revealed: w.isRevealed
      }))
    }));

    io.to(recipient.socketId).emit("room:update", {
      code: room.code,
      selfId: recipient.id,
      players: safePlayers,
      game: {
        status: room.game.status,
        currentRound: room.game.currentRound,
        revealedGoldenCableCount: room.game.revealedGoldenCableCount,
        goldenCableTarget: room.game.goldenCableTarget,
        revealedCards: room.game.revealedCards,
        currentCutterId: room.game.currentCutterId,
        winner: room.game.winner,
        actionsRemainingInRound: room.game.actionsRemainingInRound
      }
    });
  });
};

const startRound = (room, roundNumber, openingId = null) => {
  // 1. Vidage des mains précédent pour éviter les doublons
  room.players.forEach(p => p.wires = []);
  
  // 2. Pioche des cartes non révélées uniquement
  let cardsToDistribute = shuffle(room.game.deck.filter(c => !c.isRevealed));
  
  // 3. Distribution équitable
  let i = 0;
  while (cardsToDistribute.length > 0) {
    const card = cardsToDistribute.pop();
    const currentPlayer = room.players[i % room.players.length];
    currentPlayer.wires.push(card);
    i++;
  }

  room.game.currentRound = roundNumber;
  room.game.status = "playing";
  room.game.actionsRemainingInRound = room.players.length;
  room.game.currentCutterId = openingId || room.players[0].id;
};

// --- HANDLERS SOCKET ---

io.on("connection", (socket) => {
  socket.on("room:create", ({ name }) => {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const player = { id: randomId(), socketId: socket.id, name, connected: true, wires: [] };
    const room = {
      code,
      players: [player],
      game: { status: "waiting", currentRound: 0, revealedGoldenCableCount: 0, goldenCableTarget: 0, revealedCards: [], deck: [] }
    };
    rooms.set(code, room);
    socket.data = { roomCode: code, playerId: player.id };
    socket.join(code);
    emitRoomState(room);
  });

  socket.on("room:join", ({ code, name }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room || room.game.status !== "waiting" || room.players.length >= 8) return;
    const player = { id: randomId(), socketId: socket.id, name, connected: true, wires: [] };
    room.players.push(player);
    socket.data = { roomCode: room.code, playerId: player.id };
    socket.join(room.code);
    emitRoomState(room);
  });

  socket.on("game:start", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.game.status !== "waiting" || room.players.length < 4) return;
    
    room.game.deck = createDynamicDeck(room.players.length);
    room.game.goldenCableTarget = room.players.length;
    room.game.revealedGoldenCableCount = 0;
    room.game.revealedCards = [];
    startRound(room, 1);
    emitRoomState(room);
  });

  socket.on("turn:cut", ({ targetPlayerId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.game.status !== "playing" || room.game.currentCutterId !== socket.data.playerId) return;

    const target = room.players.find(p => p.id === targetPlayerId);
    if (!target || target.id === socket.data.playerId) return;

    const wire = target.wires.find(w => !w.isRevealed);
    if (!wire) return;

    wire.isRevealed = true;
    room.game.revealedCards.push({ type: wire.type, playerName: target.name });

    if (wire.type === "big_ben") {
      room.game.status = "ended";
      room.game.winner = "Moriarty";
    } else if (wire.type === "golden_cable") {
      room.game.revealedGoldenCableCount++;
      if (room.game.revealedGoldenCableCount >= room.game.goldenCableTarget) {
        room.game.status = "ended";
        room.game.winner = "Sherlock";
      }
    }

    if (room.game.status === "playing") {
      room.game.actionsRemainingInRound--;
      if (room.game.actionsRemainingInRound <= 0) {
        if (room.game.currentRound >= MAX_ROUNDS) {
          room.game.status = "ended";
          room.game.winner = "Moriarty";
        } else {
          startRound(room, room.game.currentRound + 1, target.id);
        }
      } else {
        room.game.currentCutterId = target.id;
      }
    }
    emitRoomState(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (room) {
      const player = room.players.find(p => p.id === socket.data.playerId);
      if (player) player.connected = false;
      emitRoomState(room);
    }
  });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../client/dist/index.html")));
server.listen(PORT, () => console.log(`Serveur opérationnel sur le port ${PORT}`));