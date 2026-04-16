import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3001;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const ROOM_CODE_LENGTH = 6;
const BIG_BEN_CARDS = 1;
const MAX_ROUNDS = 4;
const CHAT_LIMIT = 80;
const ROUND_HAND_SIZES = [5, 4, 3, 2];
const ALLOWED_AVATAR_IDS = new Set([
  "detective-loupe",
  "top-hat",
  "umbrella-lady",
  "yard-inspector",
  "inventor",
  "newspaper-boy",
  "chemist",
  "masked-noble"
]);
const rooms = new Map();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverText = {
  system: "Système",
  currentCutterWaiting: "En attente",
  roomNotFound: "Salle introuvable.",
  roomFull: "Cette salle est déjà pleine.",
  matchAlreadyStarted: "La partie a déjà commencé.",
  hostNow: (name) => `${name} est maintenant l'hôte.`,
  createdRoom: (name) => `${name} a créé la salle.`,
  joinedRoom: (name) => `${name} a rejoint la salle.`,
  leftRoom: (name) => `${name} a quitté la salle.`,
  tooManyPlayersLeft: "Trop de joueurs sont partis. La partie est terminée.",
  onlyHostCanStart: "Seul l'hôte peut lancer la partie.",
  connectedPlayersRequired:
    "Une partie nécessite entre 4 et 8 joueurs connectés.",
  matchStarted: "La partie a commencé. Les rôles et les fils ont été attribués.",
  enoughGoldenCables: "Tous les cables dores ont ete trouves. Les Sherlock gagnent.",
  bigBenTriggered: "Big Ben a ete revele. Les Moriarty gagnent immediatement.",
  maxRoundsReached:
    "La 4e manche est terminee sans victoire des Sherlock. Les Moriarty gagnent.",
  gameNotInProgress: "La partie n'est pas en cours.",
  notYourTurn: "Ce n'est pas votre tour.",
  mustTargetAnotherPlayer: "Vous devez viser un autre joueur.",
  targetPlayerNotFound: "Joueur cible introuvable.",
  noHiddenWiresRemaining: "Ce joueur n'a plus de fils cachés.",
  invalidPlayerName: "Saisissez un nom de joueur valide.",
  enterRoomCodeAndName: "Saisissez un code de salle et un nom de joueur.",
  roundStarted: (roundNumber, cardsPerPlayer) =>
    `Manche ${roundNumber} : ${cardsPerPlayer} actions de coupe pour cette manche.`
};

const app = express();
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

const clientDistPath = path.resolve(__dirname, "../client/dist");
app.use(express.static(clientDistPath));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    credentials: true
  }
});

const randomId = () => Math.random().toString(36).slice(2, 10);

const shuffle = (items) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
};

const generateCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () => {
      const index = Math.floor(Math.random() * alphabet.length);
      return alphabet[index];
    }).join("");
  } while (rooms.has(code));
  return code;
};

const addSystemChat = (room, message) => {
  room.chat.push({
    id: randomId(),
    system: true,
    playerId: "system",
    playerName: serverText.system,
    message,
    createdAt: Date.now()
  });
  room.chat = room.chat.slice(-CHAT_LIMIT);
};

const activePlayers = (room) => room.players.filter((player) => player.connected);
const sanitizeAvatarId = (avatarId) =>
  ALLOWED_AVATAR_IDS.has(avatarId) ? avatarId : "detective-loupe";

const teamSplitFor = (playerCount) => {
  if (playerCount === 4) {
    return Math.random() < 0.5
      ? { sherlocks: 3, moriartys: 1 }
      : { sherlocks: 2, moriartys: 2 };
  }
  if (playerCount === 5) {
    return { sherlocks: 3, moriartys: 2 };
  }
  if (playerCount === 6) {
    return { sherlocks: 4, moriartys: 2 };
  }
  if (playerCount === 7) {
    return Math.random() < 0.5
      ? { sherlocks: 4, moriartys: 3 }
      : { sherlocks: 5, moriartys: 2 };
  }
  return { sherlocks: 5, moriartys: 3 };
};

const deckCountsFor = (playerCount) => {
  const countsByPlayers = {
    4: { neutral: 15, golden: 4, bigBen: BIG_BEN_CARDS },
    5: { neutral: 19, golden: 5, bigBen: BIG_BEN_CARDS },
    6: { neutral: 23, golden: 6, bigBen: BIG_BEN_CARDS },
    7: { neutral: 27, golden: 7, bigBen: BIG_BEN_CARDS },
    8: { neutral: 31, golden: 8, bigBen: BIG_BEN_CARDS }
  };

  return countsByPlayers[playerCount];
};

const cardsPerPlayerForRound = (_playerCount, roundNumber) =>
  ROUND_HAND_SIZES[roundNumber - 1] ?? ROUND_HAND_SIZES[ROUND_HAND_SIZES.length - 1];

const createDeck = (playerCount) => {
  const counts = deckCountsFor(playerCount);
  const deck = [];
  let hasBigBenBeenAdded = false;

  for (let index = 0; index < counts.neutral; index += 1) deck.push("neutral_cable");
  for (let index = 0; index < counts.golden; index += 1) deck.push("golden_cable");

  if (!hasBigBenBeenAdded) {
    deck.push("big_ben");
    hasBigBenBeenAdded = true;
  }

  const bigBenCount = deck.filter((card) => card === "big_ben").length;
  if (bigBenCount !== 1 || deck.length !== counts.neutral + counts.golden + counts.bigBen) {
    throw new Error("Deck generation failed: expected exactly one Big Ben card.");
  }

  return shuffle(deck);
};

const createGameState = (room, roundNumber = 1, previousGame = room.game) => {
  const players = activePlayers(room);
  const shuffledPlayers = shuffle(players);
  const teamSplit = teamSplitFor(players.length);
  const cardsPerPlayer = cardsPerPlayerForRound(players.length, roundNumber);
  const roles = shuffle([
    ...Array.from({ length: teamSplit.sherlocks }, () => "Sherlock"),
    ...Array.from({ length: teamSplit.moriartys }, () => "Moriarty")
  ]);
  const fullDeck = createDeck(players.length);
  const roundDeck = fullDeck.slice(0, players.length * cardsPerPlayer);

  players.forEach((player, index) => {
    if (player.role === "Hidden") {
      player.role = roles[index];
    }
    player.wires = Array.from({ length: cardsPerPlayer }, () => ({
      id: randomId(),
      type: roundDeck.pop(),
      revealed: false
    }));
  });

  return {
    status: "playing",
    currentCutterId: shuffledPlayers[0].id,
    hasBigBenBeenAdded: true,
    blockedDrawTargets: {},
    currentRound: roundNumber,
    maxRounds: MAX_ROUNDS,
    cardsPerPlayer,
    roundActionCount: cardsPerPlayer,
    actionsRemainingInRound: cardsPerPlayer,
    revealedCards: previousGame?.revealedCards ?? [],
    revealedNeutralCableCount: previousGame?.revealedNeutralCableCount ?? 0,
    revealedGoldenCableCount: previousGame?.revealedGoldenCableCount ?? 0,
    revealedBigBenCount: previousGame?.revealedBigBenCount ?? 0,
    goldenCableTarget: deckCountsFor(players.length).golden,
    winner: previousGame?.winner ?? null,
    winningTeam: previousGame?.winningTeam ?? null,
    lastRevealed: null
  };
};

const startRound = (room, roundNumber) => {
  room.game = createGameState(room, roundNumber, room.game);
  addSystemChat(room, serverText.roundStarted(room.game.currentRound, room.game.cardsPerPlayer));
};

const publicPlayerView = (viewerId, player, gameStatus) => {
  const isSelf = viewerId === player.id;
  const revealAll = gameStatus === "ended";

  return {
    id: player.id,
    name: player.name,
    avatarId: player.avatarId,
    isHost: player.isHost,
    connected: player.connected,
    role: isSelf || revealAll ? player.role : "Hidden",
    wires: player.wires.map((wire) => {
      if (wire.revealed || isSelf || revealAll) return wire;
      return { id: wire.id, type: "hidden", revealed: false };
    }),
    unrevealedCount: player.wires.filter((wire) => !wire.revealed).length,
    revealedCount: player.wires.filter((wire) => wire.revealed).length
  };
};

const buildRoomState = (room, viewerId) => {
  const cutter = room.players.find((player) => player.id === room.game.currentCutterId);
  const blockedTargetId = room.game.blockedDrawTargets?.[viewerId] || null;
  const blockedTargetPlayer = room.players.find((player) => player.id === blockedTargetId);
  return {
    code: room.code,
    selfId: viewerId,
    hostId: room.hostId,
    chat: room.chat,
    players: room.players.map((player) =>
      publicPlayerView(viewerId, player, room.game.status)
    ),
    game: {
      ...room.game,
      currentCutterName: cutter?.name || serverText.currentCutterWaiting,
      blockedTargetId,
      blockedTargetName: blockedTargetPlayer?.name || null,
      revealedCards: room.game.status === "waiting" ? [] : room.game.revealedCards
    }
  };
};

const emitRoomState = (room) => {
  room.players.forEach((player) => {
    io.to(player.socketId).emit("room:update", buildRoomState(room, player.id));
  });
};

const ensureRoom = (code) => rooms.get(code);

const cleanupRoomIfEmpty = (room) => {
  if (!room.players.length) rooms.delete(room.code);
};

const transferHostIfNeeded = (room) => {
  const currentHost = room.players.find((player) => player.id === room.hostId);
  if (currentHost) return;

  const nextHost = room.players[0];
  if (!nextHost) return;

  room.hostId = nextHost.id;
  room.players = room.players.map((player) => ({
    ...player,
    isHost: player.id === nextHost.id
  }));
  addSystemChat(room, serverText.hostNow(nextHost.name));
};

const createRoom = (socket, name, avatarId) => {
  const code = generateCode();
  const player = {
    id: randomId(),
    socketId: socket.id,
    name,
    avatarId: sanitizeAvatarId(avatarId),
    isHost: true,
    connected: true,
    role: "Hidden",
    wires: []
  };

  const room = {
    code,
    hostId: player.id,
    players: [player],
    chat: [],
    game: {
      status: "waiting",
      currentCutterId: null,
      hasBigBenBeenAdded: false,
      blockedDrawTargets: {},
      currentRound: 0,
      maxRounds: MAX_ROUNDS,
      cardsPerPlayer: 0,
      roundActionCount: 0,
      actionsRemainingInRound: 0,
      revealedCards: [],
      revealedNeutralCableCount: 0,
      revealedGoldenCableCount: 0,
      revealedBigBenCount: 0,
      goldenCableTarget: 0,
      winner: null,
      winningTeam: null,
      lastRevealed: null
    }
  };

  rooms.set(code, room);
  socket.data.roomCode = code;
  socket.data.playerId = player.id;
  socket.join(code);
  addSystemChat(room, serverText.createdRoom(name));
  emitRoomState(room);
};

const joinRoom = (socket, code, name, avatarId) => {
  const room = ensureRoom(code);
  if (!room) {
    io.to(socket.id).emit("error:message", serverText.roomNotFound);
    return;
  }
  if (room.players.length >= 8) {
    io.to(socket.id).emit("error:message", serverText.roomFull);
    return;
  }
  if (room.game.status !== "waiting") {
    io.to(socket.id).emit("error:message", serverText.matchAlreadyStarted);
    return;
  }

  const player = {
    id: randomId(),
    socketId: socket.id,
    name,
    avatarId: sanitizeAvatarId(avatarId),
    isHost: false,
    connected: true,
    role: "Hidden",
    wires: []
  };

  room.players.push(player);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  addSystemChat(room, serverText.joinedRoom(name));
  emitRoomState(room);
};

const removePlayerFromRoom = (socket) => {
  const roomCode = socket.data.roomCode;
  const playerId = socket.data.playerId;
  if (!roomCode || !playerId) return;

  const room = ensureRoom(roomCode);
  if (!room) return;

  const departingPlayer = room.players.find((player) => player.id === playerId);
  room.players = room.players.filter((player) => player.id !== playerId);
  socket.leave(roomCode);

  if (departingPlayer) {
    addSystemChat(room, serverText.leftRoom(departingPlayer.name));
  }

  transferHostIfNeeded(room);

  if (room.game.status === "playing" && room.game.currentCutterId === playerId) {
    room.game.currentCutterId = room.players[0]?.id || null;
  }

  if (room.game.status === "playing" && room.players.length < 4) {
    room.game.status = "ended";
    room.game.winner = "Moriarty";
    room.game.winningTeam = "Moriarty";
    addSystemChat(room, serverText.tooManyPlayersLeft);
  }

  emitRoomState(room);
  cleanupRoomIfEmpty(room);
  delete socket.data.roomCode;
  delete socket.data.playerId;
  io.to(socket.id).emit("room:left");
};

const moveSocketOutOfCurrentRoom = (socket) => {
  if (socket.data.roomCode && socket.data.playerId) {
    removePlayerFromRoom(socket);
  }
};

const startGame = (socket) => {
  const room = ensureRoom(socket.data.roomCode);
  if (!room) return;

  if (socket.data.playerId !== room.hostId) {
    io.to(socket.id).emit("error:message", serverText.onlyHostCanStart);
    return;
  }

  const players = activePlayers(room);
  if (players.length < 4 || players.length > 8) {
    io.to(socket.id).emit(
      "error:message",
      serverText.connectedPlayersRequired
    );
    return;
  }

  addSystemChat(room, serverText.matchStarted);
  startRound(room, 1);
  emitRoomState(room);
};

const endGameIfNeeded = (room, revealedType, targetPlayer) => {
  if (revealedType === "neutral_cable") room.game.revealedNeutralCableCount += 1;
  if (revealedType === "golden_cable") room.game.revealedGoldenCableCount += 1;
  if (revealedType === "big_ben") room.game.revealedBigBenCount += 1;

  if (revealedType === "big_ben" && targetPlayer?.role === "Sherlock") {
    room.game.status = "ended";
    room.game.winner = "Moriarty";
    room.game.winningTeam = "Moriarty";
    addSystemChat(room, serverText.bigBenTriggered);
    return true;
  }

  if (room.game.revealedGoldenCableCount >= room.game.goldenCableTarget) {
    room.game.status = "ended";
    room.game.winner = "Sherlock";
    room.game.winningTeam = "Sherlock";
    addSystemChat(room, serverText.enoughGoldenCables);
    return true;
  }

  return false;
};

const handleCut = (socket, targetPlayerId) => {
  const room = ensureRoom(socket.data.roomCode);
  if (!room) return;

  if (room.game.status !== "playing") {
    io.to(socket.id).emit("error:message", serverText.gameNotInProgress);
    return;
  }
  if (room.game.currentCutterId !== socket.data.playerId) {
    io.to(socket.id).emit("error:message", serverText.notYourTurn);
    return;
  }
  if (targetPlayerId === socket.data.playerId) {
    io.to(socket.id).emit("error:message", serverText.mustTargetAnotherPlayer);
    return;
  }

  const actingPlayer = room.players.find((player) => player.id === socket.data.playerId);
  const targetPlayer = room.players.find((player) => player.id === targetPlayerId);
  if (!actingPlayer || !targetPlayer) {
    io.to(socket.id).emit("error:message", serverText.targetPlayerNotFound);
    return;
  }

  const blockedTargetId = room.game.blockedDrawTargets?.[actingPlayer.id];
  if (blockedTargetId && blockedTargetId === targetPlayer.id) {
    io.to(socket.id).emit(
      "error:message",
      `Vous ne pouvez pas viser ${targetPlayer.name} ce tour-ci.`
    );
    return;
  }

  const availableWires = targetPlayer.wires.filter((wire) => !wire.revealed);
  if (!availableWires.length) {
    io.to(socket.id).emit("error:message", serverText.noHiddenWiresRemaining);
    return;
  }

  const selectedWire =
    availableWires[Math.floor(Math.random() * availableWires.length)];
  selectedWire.revealed = true;

  const revealedCard = {
    id: randomId(),
    type: selectedWire.type,
    playerId: targetPlayer.id,
    playerName: targetPlayer.name,
    revealedBy: actingPlayer.name,
    revealedAt: Date.now()
  };

  room.game.revealedCards.push(revealedCard);
  room.game.lastRevealed = revealedCard;
  room.game.blockedDrawTargets[targetPlayer.id] = actingPlayer.id;

  const ended = endGameIfNeeded(room, selectedWire.type, targetPlayer);
  if (!ended) {
    room.game.actionsRemainingInRound = Math.max(
      0,
      (room.game.actionsRemainingInRound ?? room.game.cardsPerPlayer) - 1
    );

    if (room.game.blockedDrawTargets[actingPlayer.id]) {
      delete room.game.blockedDrawTargets[actingPlayer.id];
    }

    if (room.game.actionsRemainingInRound === 0) {
      if (room.game.currentRound >= room.game.maxRounds) {
        room.game.status = "ended";
        room.game.winner = "Moriarty";
        room.game.winningTeam = "Moriarty";
        addSystemChat(room, serverText.maxRoundsReached);
      } else {
        startRound(room, room.game.currentRound + 1);
      }
    } else {
      room.game.currentCutterId = targetPlayer.id;
    }
  }

  emitRoomState(room);
};

const handleChat = (socket, message) => {
  const room = ensureRoom(socket.data.roomCode);
  const player = room?.players.find((entry) => entry.id === socket.data.playerId);
  if (!room || !player || !message.trim()) return;

  room.chat.push({
    id: randomId(),
    system: false,
    playerId: player.id,
    playerName: player.name,
    message: message.slice(0, 220),
    createdAt: Date.now()
  });
  room.chat = room.chat.slice(-CHAT_LIMIT);
  emitRoomState(room);
};

io.on("connection", (socket) => {
  socket.on("room:create", ({ name, avatarId }) => {
    if (!name?.trim()) {
      io.to(socket.id).emit("error:message", serverText.invalidPlayerName);
      return;
    }
    moveSocketOutOfCurrentRoom(socket);
    createRoom(socket, name.trim(), avatarId);
  });

  socket.on("room:join", ({ code, name, avatarId }) => {
    if (!code?.trim() || !name?.trim()) {
      io.to(socket.id).emit("error:message", serverText.enterRoomCodeAndName);
      return;
    }
    moveSocketOutOfCurrentRoom(socket);
    joinRoom(socket, code.trim().toUpperCase(), name.trim(), avatarId);
  });

  socket.on("room:leave", () => removePlayerFromRoom(socket));
  socket.on("game:start", () => startGame(socket));
  socket.on("turn:cut", ({ targetPlayerId }) => handleCut(socket, targetPlayerId));
  socket.on("chat:send", ({ message }) => handleChat(socket, message ?? ""));
  socket.on("disconnect", () => removePlayerFromRoom(socket));
});

app.get("*", (_request, response) => {
  response.sendFile(path.join(clientDistPath, "index.html"));
});

server.listen(PORT, () => {
  console.log(`Wire Room server listening on http://localhost:${PORT}`);
});
