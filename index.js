import express from "express";
import cors from "cors";
import http from "http";
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

const serverText = {
  system: "Systeme",
  currentCutterWaiting: "En attente",
  roomNotFound: "Salle introuvable.",
  roomFull: "Cette salle est deja pleine.",
  matchAlreadyStarted: "La partie a deja commence.",
  hostNow: (name) => `${name} est maintenant l'hote.`,
  createdRoom: (name) => `${name} a cree la salle.`,
  joinedRoom: (name) => `${name} a rejoint la salle.`,
  leftRoom: (name) => `${name} a quitte la salle.`,
  tooManyPlayersLeft: "Trop de joueurs sont partis. La partie est terminee.",
  onlyHostCanStart: "Seul l'hote peut lancer la partie.",
  connectedPlayersRequired: "Une partie necessite entre 4 et 8 joueurs connectes.",
  matchStarted: "La partie a commence. Les roles et les cartes ont ete attribues.",
  enoughGoldenCables: "Tous les cables dores ont ete trouves. Les Sherlock gagnent.",
  bigBenTriggered: "Big Ben a ete revele. Les Moriarty gagnent immediatement.",
  maxRoundsReached: "La 4e manche est terminee sans victoire des Sherlock. Les Moriarty gagnent.",
  replayStarted: "Une nouvelle partie commence dans la meme salle.",
  gameNotInProgress: "La partie n'est pas en cours.",
  replayUnavailable: "Vous ne pouvez rejouer qu'a la fin d'une partie terminee.",
  notYourTurn: "Ce n'est pas votre tour.",
  mustTargetAnotherPlayer: "Vous devez viser un autre joueur.",
  targetPlayerNotFound: "Joueur cible introuvable.",
  noHiddenWiresRemaining: "Ce joueur n'a plus de cartes cachees.",
  invalidPlayerName: "Saisissez un nom de joueur valide.",
  enterRoomCodeAndName: "Saisissez un code de salle et un nom de joueur.",
  roundStarted: (roundNumber, cardsPerPlayer) =>
    `Manche ${roundNumber} : distribution de ${cardsPerPlayer} cartes maximum par joueur.`,
  blockedTarget: (name) => `Vous ne pouvez pas viser ${name} ce tour-ci.`
};

const app = express();
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- UTILITAIRES ---

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
  if (playerCount === 5) return { sherlocks: 3, moriartys: 2 };
  if (playerCount === 6) return { sherlocks: 4, moriartys: 2 };
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

// --- GESTION DU DECK ET DES CARTES ---

const createPersistentDeck = (playerCount) => {
  const counts = deckCountsFor(playerCount);
  const deck = [];
  for (let i = 0; i < counts.neutral; i++) {
    deck.push({ id: randomId(), type: "neutral_cable", isRevealed: false, holderPlayerId: null });
  }
  for (let i = 0; i < counts.golden; i++) {
    deck.push({ id: randomId(), type: "golden_cable", isRevealed: false, holderPlayerId: null });
  }
  deck.push({ id: randomId(), type: "big_ben", isRevealed: false, holderPlayerId: null });
  return shuffle(deck);
};

const assignRolesIfNeeded = (room) => {
  const players = activePlayers(room);
  if (!players.some((player) => player.role === "Hidden")) return;

  const split = teamSplitFor(players.length);
  const roles = shuffle([
    ...Array.from({ length: split.sherlocks }, () => "Sherlock"),
    ...Array.from({ length: split.moriartys }, () => "Moriarty")
  ]);
  players.forEach((player, index) => {
    player.role = roles[index];
  });
};

const buildPlayerHandsFromDeck = (room, roundNumber) => {
  const players = activePlayers(room);
  players.forEach((p) => {
    p.wires = [];
  });

  let cardsToDistribute = shuffle(room.game.deck.filter((c) => !c.isRevealed));

  let i = 0;
  while (cardsToDistribute.length > 0) {
    const card = cardsToDistribute.pop();
    const currentPlayer = players[i % players.length];
    card.holderPlayerId = currentPlayer.id;
    currentPlayer.wires.push(card);
    i++;
  }

  return {
    perPlayerTarget: players[0] ? players[0].wires.length : 0,
    distributedCount: players.length
  };
};

// --- LOGIQUE DE TOUR ET MANCHE ---

const resolveOpeningPlayerId = (room, preferredPlayerId = null) => {
  const players = activePlayers(room);
  if (preferredPlayerId && players.some((p) => p.id === preferredPlayerId)) return preferredPlayerId;
  if (room.game.lastCutTargetId && players.some((p) => p.id === room.game.lastCutTargetId)) return room.game.lastCutTargetId;
  return shuffle(players)[0]?.id || null;
};

const startRound = (room, roundNumber, preferredOpeningPlayerId = null) => {
  const { perPlayerTarget } = buildPlayerHandsFromDeck(room, roundNumber);
  const openingPlayerId = resolveOpeningPlayerId(room, preferredOpeningPlayerId);
  const playersCount = activePlayers(room).length;

  room.game.status = "playing";
  room.game.currentRound = roundNumber;
  room.game.cardsPerPlayer = perPlayerTarget;
  room.game.actionsRemainingInRound = playersCount;
  room.game.roundActionCount = playersCount;
  room.game.currentCutterId = openingPlayerId;
  room.game.lastRevealed = null;
  room.game.blockedDrawTargets = room.game.blockedDrawTargets || {};

  addSystemChat(room, serverText.roundStarted(roundNumber, perPlayerTarget));
};

const endGame = (room, winner, message) => {
  room.game.status = "ended";
  room.game.winner = winner;
  room.game.winningTeam = winner;
  addSystemChat(room, message);
};

const resetPlayersForNewGame = (room) => {
  room.players.forEach((player) => {
    player.role = "Hidden";
    player.wires = [];
  });
};

// --- ACTIONS DE JEU ---

const handleCut = (socket, targetPlayerId) => {
  const room = ensureRoom(socket.data.roomCode);
  if (!room || room.game.status !== "playing") return;

  if (room.game.currentCutterId !== socket.data.playerId) {
    io.to(socket.id).emit("error:message", serverText.notYourTurn);
    return;
  }

  const targetPlayer = room.players.find((p) => p.id === targetPlayerId);
  if (!targetPlayer) return;

  const blockedTargetId = room.game.blockedDrawTargets?.[socket.data.playerId];
  if (blockedTargetId && blockedTargetId === targetPlayerId) {
    io.to(socket.id).emit("error:message", serverText.blockedTarget(targetPlayer.name));
    return;
  }

  const availableWires = targetPlayer.wires.filter((w) => !w.isRevealed);
  if (availableWires.length === 0) {
    io.to(socket.id).emit("error:message", serverText.noHiddenWiresRemaining);
    return;
  }

  const selectedWire = availableWires[Math.floor(Math.random() * availableWires.length)];
  selectedWire.isRevealed = true;

  const revealedCard = {
    id: randomId(),
    type: selectedWire.type,
    playerId: targetPlayer.id,
    playerName: targetPlayer.name,
    revealedBy: room.players.find((p) => p.id === socket.data.playerId).name,
    revealedAt: Date.now()
  };

  room.game.revealedCards.push(revealedCard);
  room.game.lastRevealed = revealedCard;
  room.game.lastCutTargetId = targetPlayer.id;
  room.game.blockedDrawTargets = room.game.blockedDrawTargets || {};
  room.game.blockedDrawTargets[targetPlayer.id] = socket.data.playerId;

  if (selectedWire.type === "big_ben") {
    room.game.revealedBigBenCount = 1;
    endGame(room, "Moriarty", serverText.bigBenTriggered);
  } else if (selectedWire.type === "golden_cable") {
    room.game.revealedGoldenCableCount += 1;
    if (room.game.revealedGoldenCableCount >= room.game.goldenCableTarget) {
      endGame(room, "Sherlock", serverText.enoughGoldenCables);
    }
  } else {
    room.game.revealedNeutralCableCount += 1;
  }

  if (room.game.status === "playing") {
    if (room.game.blockedDrawTargets[socket.data.playerId]) {
      delete room.game.blockedDrawTargets[socket.data.playerId];
    }

    room.game.actionsRemainingInRound -= 1;
    if (room.game.actionsRemainingInRound <= 0) {
      if (room.game.currentRound >= room.game.maxRounds) {
        endGame(room, "Moriarty", serverText.maxRoundsReached);
      } else {
        startRound(room, room.game.currentRound + 1, room.game.lastCutTargetId);
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

// --- GESTION DE L'ETAT ET DES VUES ---

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
    wires: player.wires.map((wire) => ({
      id: wire.id,
      type: wire.isRevealed || isSelf || revealAll ? wire.type : "hidden",
      revealed: wire.isRevealed
    })),
    unrevealedCount: player.wires.filter((wire) => !wire.isRevealed).length,
    revealedCount: player.wires.filter((wire) => wire.isRevealed).length
  };
};

const buildRoomState = (room, viewerId) => {
  const cutter = room.players.find((player) => player.id === room.game.currentCutterId);
  const blockedTargetId = room.game.blockedDrawTargets?.[viewerId] || null;
  return {
    code: room.code,
    selfId: viewerId,
    hostId: room.hostId,
    chat: room.chat,
    players: room.players.map((player) => publicPlayerView(viewerId, player, room.game.status)),
    game: {
      status: room.game.status,
      currentCutterId: room.game.currentCutterId,
      currentCutterName: cutter?.name || serverText.currentCutterWaiting,
      currentRound: room.game.currentRound,
      maxRounds: room.game.maxRounds,
      cardsPerPlayer: room.game.cardsPerPlayer,
      roundActionCount: room.game.roundActionCount,
      actionsRemainingInRound: room.game.actionsRemainingInRound,
      revealedCards: room.game.status === "waiting" ? [] : room.game.revealedCards,
      revealedNeutralCableCount: room.game.revealedNeutralCableCount,
      revealedGoldenCableCount: room.game.revealedGoldenCableCount,
      revealedBigBenCount: room.game.revealedBigBenCount,
      goldenCableTarget: room.game.goldenCableTarget,
      winner: room.game.winner,
      winningTeam: room.game.winningTeam,
      lastRevealed: room.game.lastRevealed,
      blockedTargetId
    }
  };
};

const emitRoomState = (room) => {
  room.players.forEach((player) => {
    io.to(player.socketId).emit("room:update", buildRoomState(room, player.id));
  });
};

const ensureRoom = (code) => rooms.get(code);

const removePlayerFromRoom = (socket) => {
  const { roomCode, playerId } = socket.data;
  if (!roomCode || !playerId) return;
  const room = ensureRoom(roomCode);
  if (!room) return;

  const departingPlayer = room.players.find((p) => p.id === playerId);
  room.players = room.players.filter((p) => p.id !== playerId);
  socket.leave(roomCode);

  if (departingPlayer) addSystemChat(room, serverText.leftRoom(departingPlayer.name));

  if (!room.players.length) {
    rooms.delete(room.code);
  } else {
    if (room.hostId === playerId) {
      room.hostId = room.players[0].id;
      room.players[0].isHost = true;
      addSystemChat(room, serverText.hostNow(room.players[0].name));
    }
    if (room.game.status === "playing" && room.players.length < 4) {
      endGame(room, "Moriarty", serverText.tooManyPlayersLeft);
    }
    emitRoomState(room);
  }
};

const startGame = (socket) => {
  const room = ensureRoom(socket.data.roomCode);
  if (!room || socket.data.playerId !== room.hostId) return;

  const players = activePlayers(room);
  if (players.length < 4 || players.length > 8) {
    io.to(socket.id).emit("error:message", serverText.connectedPlayersRequired);
    return;
  }

  assignRolesIfNeeded(room);
  room.game.deck = createPersistentDeck(players.length);
  room.game.goldenCableTarget = deckCountsFor(players.length).golden;
  room.game.revealedCards = [];
  room.game.revealedNeutralCableCount = 0;
  room.game.revealedGoldenCableCount = 0;
  room.game.revealedBigBenCount = 0;
  room.game.winner = null;
  room.game.winningTeam = null;
  room.game.lastRevealed = null;
  room.game.lastCutTargetId = null;

  addSystemChat(room, serverText.matchStarted);
  startRound(room, 1, null);
  emitRoomState(room);
};

const replayGame = (socket) => {
  const room = ensureRoom(socket.data.roomCode);
  if (!room || socket.data.playerId !== room.hostId) return;
  if (room.game.status !== "ended") {
    io.to(socket.id).emit("error:message", serverText.replayUnavailable);
    return;
  }

  const players = activePlayers(room);
  if (players.length < 4 || players.length > 8) {
    io.to(socket.id).emit("error:message", serverText.connectedPlayersRequired);
    return;
  }

  resetPlayersForNewGame(room);
  room.game.deck = createPersistentDeck(players.length);
  room.game.goldenCableTarget = deckCountsFor(players.length).golden;
  room.game.revealedCards = [];
  room.game.revealedNeutralCableCount = 0;
  room.game.revealedGoldenCableCount = 0;
  room.game.revealedBigBenCount = 0;
  room.game.winner = null;
  room.game.winningTeam = null;
  room.game.lastRevealed = null;
  room.game.lastCutTargetId = null;
  room.game.blockedDrawTargets = {};
  room.game.currentCutterId = null;
  room.game.currentRound = 0;
  room.game.cardsPerPlayer = 0;
  room.game.roundActionCount = 0;
  room.game.actionsRemainingInRound = 0;

  assignRolesIfNeeded(room);
  addSystemChat(room, serverText.replayStarted);
  startRound(room, 1, null);
  emitRoomState(room);
};

// --- SERVEUR ET SOCKETS ---

io.on("connection", (socket) => {
  socket.on("room:create", ({ name, avatarId }) => {
    if (!name?.trim()) return;
    const code = generateCode();
    const player = {
      id: randomId(),
      socketId: socket.id,
      name: name.trim(),
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
        lastRevealed: null,
        deck: [],
        lastCutTargetId: null,
        blockedDrawTargets: {}
      }
    };
    rooms.set(code, room);
    socket.data = { roomCode: code, playerId: player.id };
    socket.join(code);
    addSystemChat(room, serverText.createdRoom(name));
    emitRoomState(room);
  });

  socket.on("room:join", ({ code, name, avatarId }) => {
    const room = ensureRoom(code?.toUpperCase());
    if (!room || room.players.length >= 8 || room.game.status !== "waiting") return;
    const player = {
      id: randomId(),
      socketId: socket.id,
      name: name.trim(),
      avatarId: sanitizeAvatarId(avatarId),
      isHost: false,
      connected: true,
      role: "Hidden",
      wires: []
    };
    room.players.push(player);
    socket.data = { roomCode: room.code, playerId: player.id };
    socket.join(room.code);
    addSystemChat(room, serverText.joinedRoom(name));
    emitRoomState(room);
  });

  socket.on("game:start", () => startGame(socket));
  socket.on("game:replay", () => replayGame(socket));
  socket.on("room:leave", () => removePlayerFromRoom(socket));
  socket.on("turn:cut", ({ targetPlayerId }) => handleCut(socket, targetPlayerId));
  socket.on("chat:send", ({ message }) => handleChat(socket, message));
  socket.on("disconnect", () => removePlayerFromRoom(socket));
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
