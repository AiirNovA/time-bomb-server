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

const createPersistentDeck = (playerCount) => {
  // Config stricte : 4 joueurs = 15 neutres, 4 dorés, 1 Big Ben = 20 cartes
  const counts = { n: 15, g: 4 }; 
  const deck = [];
  for (let i = 0; i < counts.n; i++) deck.push({ id: randomId(), type: "neutral_cable", isRevealed: false });
  for (let i = 0; i < counts.g; i++) deck.push({ id: randomId(), type: "golden_cable", isRevealed: false });
  deck.push({ id: randomId(), type: "big_ben", isRevealed: false });
  return shuffle(deck);
};

const buildPlayerHandsFromDeck = (room) => {
  const allPlayers = room.players;
  allPlayers.forEach(p => p.wires = []);

  // On ne prend QUE les cartes qui n'ont pas encore été révélées
  let cardsToDistribute = shuffle(room.game.deck.filter(c => !c.isRevealed));
  
  let i = 0;
  while (cardsToDistribute.length > 0) {
    const card = cardsToDistribute.pop();
    const currentPlayer = allPlayers[i % allPlayers.length];
    card.holderPlayerId = currentPlayer.id;
    currentPlayer.wires.push(card);
    i++;
  }
  return allPlayers[0]?.wires.length || 0;
};

const startRound = (room, roundNumber, openingId = null) => {
  const cardsPerPlayer = buildPlayerHandsFromDeck(room);
  room.game.status = "playing";
  room.game.currentRound = roundNumber;
  room.game.cardsPerPlayer = cardsPerPlayer;
  room.game.actionsRemainingInRound = room.players.length;
  room.game.currentCutterId = openingId || room.players[0].id;
};

const handleCut = (socket, targetId) => {
  const room = rooms.get(socket.data.roomCode);
  if (!room || room.game.status !== "playing") return;
  if (room.game.currentCutterId !== socket.data.playerId) return;

  const target = room.players.find(p => p.id === targetId);
  if (!target || target.id === socket.data.playerId) return;

  const wire = target.wires.find(w => !w.isRevealed);
  if (!wire) return;

  wire.isRevealed = true; // Marque la carte dans le deck persistant
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
};

const emitRoomState = (room) => {
  room.players.forEach(recipient => {
    const state = {
      code: room.code,
      players: room.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        connected: pl.connected,
        wires: pl.wires.map(w => ({
          type: (w.isRevealed || pl.id === recipient.id || room.game.status === "ended") ? w.type : "hidden",
          revealed: w.isRevealed
        }))
      })),
      game: room.game
    };
    io.to(recipient.socketId).emit("room:update", state);
  });
};

io.on("connection", (socket) => {
  socket.on("room:create", ({ name }) => {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const player = { id: randomId(), socketId: socket.id, name, connected: true, wires: [] };
    const room = {
      code,
      players: [player],
      game: { 
        status: "waiting", 
        currentRound: 0, 
        revealedGoldenCableCount: 0, 
        goldenCableTarget: 4, 
        revealedCards: [],
        deck: [] 
      }
    };
    rooms.set(code, room);
    socket.data = { roomCode: code, playerId: player.id };
    socket.join(code);
    emitRoomState(room);
  });

  socket.on("room:join", ({ code, name }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room || room.game.status !== "waiting") return;
    const player = { id: randomId(), socketId: socket.id, name, connected: true, wires: [] };
    room.players.push(player);
    socket.data = { roomCode: code.toUpperCase(), playerId: player.id };
    socket.join(code.toUpperCase());
    emitRoomState(room);
  });

  socket.on("game:start", () => {
    const room = rooms.get(socket.data.roomCode);
    // VERROU : On ne lance que si on est en attente
    if (!room || room.game.status !== "waiting") return;
    
    room.game.deck = createPersistentDeck(room.players.length);
    startRound(room, 1);
    emitRoomState(room);
  });

  socket.on("turn:cut", ({ targetPlayerId }) => handleCut(socket, targetPlayerId));

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
server.listen(PORT, () => console.log(`Server on ${PORT}`));