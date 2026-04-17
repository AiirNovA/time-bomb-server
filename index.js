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
  gameNotInProgress: "La partie n'est pas en cours.",
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

const clientDistPath = path.resolve(__dirname, "../client/dist");
app.use(express.static(clientDistPath));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
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

const cardsPerPlayerForRound = (roundNumber) =>
  ROUND_HAND_SIZES[roundNumber - 1] ?? ROUND_HAND_SIZES[ROUND_HAND_SIZES.length - 1];

const createPersistentDeck = (playerCount) => {
  const counts = deckCountsFor(playerCount);
  const deck = [];

  for (let index = 0; index < counts.neutral; index += 1) {
    deck.push({
      id: randomId(),
      type: "neutral_cable",
      isRevealed: false,
      holderPlayerId: null
    });
  }

  for (let index = 0; index < counts.golden; index += 1) {
    deck.push({
      id: randomId(),
      type: "golden_cable",
      isRevealed: false,
      holderPlayerId: null
    });
  }

  deck.push({
    id: randomId(),
    type: "big_ben",
    isRevealed: false,
    holderPlayerId: null
  });

  const bigBenCount = deck.filter((card) => card.type === "big_ben").length;
  if (bigBenCount !== 1) {
    throw new Error("Deck generation failed: expected exactly one Big Ben.");
  }

  return shuffle(deck);
};

const assignRolesIfNeeded = (room) => {
  const players = activePlayers(room);
  const shouldAssignRoles = players.some((player) => player.role === "Hidden");

  if (!shouldAssignRoles) {
    return;
  }

  const split = teamSplitFor(players.length);
  const roles = shuffle([
    ...Array.from({ length: split.sherlocks }, () => "Sherlock"),
    ...Array.from({ length: split.moriartys }, () => "Moriarty")
  ]);

  players.forEach((player, index) => {
    player.role = roles[index];
  });
};

const clearHands = (room) => {
  room.players.forEach(player => {
    player.wires = []; // On vide REELLEMENT le tableau des cartes du joueur
  });
  
  room.game.deck.forEach(card => {
    if (!card.isRevealed) {
      card.holderPlayerId = null;
    }
  });
};

  room.players.forEach((player) => {
    player.wires = [];
  });

  room.game.deck.forEach((card) => {
    if (!card.isRevealed) {
      card.holderPlayerId = null;
    }
  });
};

const collectUnrevealedCards = (room) =>
  room.game.deck.filter((card) => !card.isRevealed);

const assertDeckIntegrity = (room) => {
  const totalGolden = room.game.deck.filter((card) => card.type === "golden_cable").length;
  const revealedGolden = room.game.deck.filter(
    (card) => card.type === "golden_cable" && card.isRevealed
  ).length;
  const hiddenGolden = room.game.deck.filter(
    (card) => card.type === "golden_cable" && !card.isRevealed
  ).length;
  const bigBenCount = room.game.deck.filter((card) => card.type === "big_ben").length;
  const revealedBigBen = room.game.deck.filter(
    (card) => card.type === "big_ben" && card.isRevealed
  ).length;

  if (totalGolden !== room.game.goldenCableTarget) {
    throw new Error("Golden cable total mismatch.");
  }

  if (revealedGolden + hiddenGolden !== room.game.goldenCableTarget) {
    throw new Error("Golden cable revealed/hidden mismatch.");
  }

  if (bigBenCount !== BIG_BEN_CARDS || revealedBigBen > BIG_BEN_CARDS) {
    throw new Error("Big Ben integrity mismatch.");
  }
};

const buildPlayerHandsFromDeck = (room, roundNumber) => {
  const players = activePlayers(room);
  
  // 1. On vide les mains de TOUS les joueurs (Nettoyage total)
  players.forEach(p => {
    p.wires = [];
  });

  // 2. On prend UNIQUEMENT les cartes qui sont encore face cachée dans le deck
  // C'est ici que tes 3 câbles dorés déjà trouvés sont définitivement écartés
  let cardsToDistribute = shuffle(room.game.deck.filter(c => c.isRevealed === false));
  
  const perPlayerTarget = Math.floor(cardsToDistribute.length / players.length);
  
  // 3. Distribution
  for (let i = 0; i < perPlayerTarget; i++) {
    players.forEach(player => {
      if (cardsToDistribute.length > 0) {
        const card = cardsToDistribute.pop();
        card.holderPlayerId = player.id;
        // On NE TOUCHE PAS à card.isRevealed ici, elle est déjà à false.
        player.wires.push(card);
      }
    });
  }

  return {
    perPlayerTarget,
    distributedCount: perPlayerTarget * players.length
  };
};

  const players = activePlayers(room);
  
  // 1. On ne prend QUE les cartes non révélées
  // On s'assure qu'elles restent bien isRevealed = false
  let cardsToDistribute = shuffle(room.game.deck.filter(c => !c.isRevealed));
  
  const perPlayerTarget = Math.floor(cardsToDistribute.length / players.length);
  
  // 2. On vide les mains actuelles SANS toucher au deck global
  players.forEach(p => {
    p.wires = [];
  });

  // 3. Distribution stricte
  for (let i = 0; i < perPlayerTarget; i++) {
    players.forEach(player => {
      if (cardsToDistribute.length > 0) {
        const card = cardsToDistribute.pop();
        card.holderPlayerId = player.id;
        // On s'assure que la carte est bien considérée comme non révélée pour ce tour
        card.isRevealed = false; 
        player.wires.push(card);
      }
    });
  }

  return {
    perPlayerTarget,
    distributedCount: perPlayerTarget * players.length
  };
};

  const players = activePlayers(room);
  // 1. On récupère TOUTES les cartes non révélées (Câbles dorés, neutres, Big Ben)
  let unrevealedCards = shuffle(collectUnrevealedCards(room));
  
  // 2. On calcule combien de cartes chaque joueur doit recevoir (ex: 16 cartes / 4 joueurs = 4)
  const perPlayerTarget = Math.floor(unrevealedCards.length / players.length);
  
  // 3. On vide les mains actuelles
  clearHands(room);

  // 4. On distribue les cartes une par une jusqu'à épuisement du quota par joueur
  for (let i = 0; i < perPlayerTarget; i++) {
    players.forEach(player => {
      if (unrevealedCards.length > 0) {
        const card = unrevealedCards.pop();
        card.holderPlayerId = player.id;
        player.wires.push(card);
      }
    });
  }

  // On renvoie les infos pour mettre à jour l'état du jeu
  return {
    perPlayerTarget,
    distributedCount: perPlayerTarget * players.length
  };
};

const resolveOpeningPlayerId = (room, preferredPlayerId = null) => {
  const players = activePlayers(room);

  if (preferredPlayerId && players.some((player) => player.id === preferredPlayerId)) {
    return preferredPlayerId;
  }

  if (
    room.game.lastCutTargetId &&
    players.some((player) => player.id === room.game.lastCutTargetId)
  ) {
    return room.game.lastCutTargetId;
  }

  if (
    room.game.currentCutterId &&
    players.some((player) => player.id === room.game.currentCutterId)
  ) {
    return room.game.currentCutterId;
  }

  return shuffle(players)[0]?.id || null;
};

const startRound = (room, roundNumber, preferredOpeningPlayerId = null) => {
  const { perPlayerTarget } = buildPlayerHandsFromDeck(room, roundNumber);
  const openingPlayerId = resolveOpeningPlayerId(room, preferredOpeningPlayerId);

  const playersCount = activePlayers(room).length;

  room.game.status = "playing";
  room.game.currentRound = roundNumber;
  room.game.cardsPerPlayer = perPlayerTarget;
  
  // TRÈS IMPORTANT : Le nombre de coupes est égal au nombre de joueurs !
  room.game.actionsRemainingInRound = playersCount; 
  room.game.roundActionCount = playersCount;
  
  room.game.currentCutterId = openingPlayerId;
  room.game.blockedDrawTargets = {};
  room.game.lastRevealed = null;

  assertDeckIntegrity(room);
  addSystemChat(room, serverText.roundStarted(roundNumber, perPlayerTarget));
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
      if (wire.isRevealed || isSelf || revealAll) {
        return {
          id: wire.id,
          type: wire.type,
          revealed: wire.isRevealed
        };
      }

      return {
        id: wire.id,
        type: "hidden",
        revealed: false
      };
    }),
    unrevealedCount: player.wires.filter((wire) => !wire.isRevealed).length,
    revealedCount: player.wires.filter((wire) => wire.isRevealed).length
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
      blockedTargetId,
      blockedTargetName: blockedTargetPlayer?.name || null
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
  if (!room.players.length) {
    rooms.delete(room.code);
  }
};

const transferHostIfNeeded = (room) => {
  const currentHost = room.players.find((player) => player.id === room.hostId);
  if (currentHost) {
    return;
  }

  const nextHost = room.players[0];
  if (!nextHost) {
    return;
  }

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
      blockedDrawTargets: {},
      deck: [],
      lastCutTargetId: null
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

const endGame = (room, winner, message) => {
  room.game.status = "ended";
  room.game.winner = winner;
  room.game.winningTeam = winner;
  addSystemChat(room, message);
};

const removePlayerFromRoom = (socket) => {
  const roomCode = socket.data.roomCode;
  const playerId = socket.data.playerId;

  if (!roomCode || !playerId) {
    return;
  }

  const room = ensureRoom(roomCode);
  if (!room) {
    return;
  }

  const departingPlayer = room.players.find((player) => player.id === playerId);
  room.players = room.players.filter((player) => player.id !== playerId);
  socket.leave(roomCode);

  if (departingPlayer) {
    addSystemChat(room, serverText.leftRoom(departingPlayer.name));
  }

  transferHostIfNeeded(room);

  if (room.game.status === "playing" && room.game.currentCutterId === playerId) {
    room.game.currentCutterId = activePlayers(room)[0]?.id || null;
  }

  if (room.game.status === "playing" && room.players.length < 4) {
    endGame(room, "Moriarty", serverText.tooManyPlayersLeft);
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
  if (!room) {
    return;
  }

  if (socket.data.playerId !== room.hostId) {
    io.to(socket.id).emit("error:message", serverText.onlyHostCanStart);
    return;
  }

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

const handleCut = (socket, targetPlayerId) => {
  const room = ensureRoom(socket.data.roomCode);
  if (!room || room.game.status !== "playing") return;

  if (room.game.currentCutterId !== socket.data.playerId) {
    io.to(socket.id).emit("error:message", serverText.notYourTurn);
    return;
  }

  const targetPlayer = room.players.find(p => p.id === targetPlayerId);
  const availableWires = targetPlayer?.wires.filter(w => !w.isRevealed);

  if (!availableWires || availableWires.length === 0) {
    io.to(socket.id).emit("error:message", serverText.noHiddenWiresRemaining);
    return;
  }

  // 1. Sélection et révélation de la carte
  const selectedWire = availableWires[Math.floor(Math.random() * availableWires.length)];
  selectedWire.isRevealed = true;
  
  // 2. Mise à jour de l'historique pour le client
  const revealedCard = {
    id: randomId(),
    type: selectedWire.type,
    playerId: targetPlayer.id,
    playerName: targetPlayer.name,
    revealedBy: room.players.find(p => p.id === socket.data.playerId).name,
    revealedAt: Date.now()
  };
  room.game.revealedCards.push(revealedCard);
  room.game.lastRevealed = revealedCard;
  room.game.lastCutTargetId = targetPlayer.id; // Crucial pour le prochain tour

  // 3. LOGIQUE DE VICTOIRE (Intégrée ici pour être infaillible)
  if (selectedWire.type === "big_ben") {
    room.game.revealedBigBenCount = 1;
    endGame(room, "Moriarty", serverText.bigBenTriggered);
    emitRoomState(room);
    return;
  }

  if (selectedWire.type === "golden_cable") {
    room.game.revealedGoldenCableCount += 1;
    if (room.game.revealedGoldenCableCount >= room.game.goldenCableTarget) {
      endGame(room, "Sherlock", serverText.enoughGoldenCables);
      emitRoomState(room);
      return;
    }
  } else {
    room.game.revealedNeutralCableCount += 1;
  }

  // 4. GESTION DU NOMBRE D'ACTIONS ET DES MANCHES
  room.game.actionsRemainingInRound -= 1;

  if (room.game.actionsRemainingInRound <= 0) {
    if (room.game.currentRound >= room.game.maxRounds) {
      endGame(room, "Moriarty", serverText.maxRoundsReached);
    } else {
      // On lance la manche suivante, le visé commence
      startRound(room, room.game.currentRound + 1, room.game.lastCutTargetId);
    }
  } else {
    // Le tour passe au joueur qui vient d'être coupé
    room.game.currentCutterId = targetPlayer.id;
  }

  emitRoomState(room);
};

const handleCut = (socket, targetPlayerId) => {
  const room = ensureRoom(socket.data.roomCode);
  if (!room || room.game.status !== "playing") return;

  // Vérification du tour
  if (room.game.currentCutterId !== socket.data.playerId) {
    io.to(socket.id).emit("error:message", serverText.notYourTurn);
    return;
  }

  const targetPlayer = room.players.find(p => p.id === targetPlayerId);
  if (!targetPlayer) return;

  const availableWires = targetPlayer.wires.filter(w => !w.isRevealed);
  if (availableWires.length === 0) {
    io.to(socket.id).emit("error:message", serverText.noHiddenWiresRemaining);
    return;
  }

  // Sélection aléatoire d'une carte chez la cible
  const selectedWire = availableWires[Math.floor(Math.random() * availableWires.length)];
  selectedWire.isRevealed = true;
  
  const actingPlayer = room.players.find(p => p.id === socket.data.playerId);
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
  room.game.lastCutTargetId = targetPlayer.id; // Le visé aura la main au tour/manche d'après

  // --- LOGIQUE DE VICTOIRE IMMÉDIATE ---
  
  // 1. BIG BEN
  if (selectedWire.type === "big_ben") {
    room.game.revealedBigBenCount = 1;
    endGame(room, "Moriarty", serverText.bigBenTriggered);
    emitRoomState(room);
    return;
  }

  // 2. CÂBLES DORÉS
  if (selectedWire.type === "golden_cable") {
    room.game.revealedGoldenCableCount += 1;
    if (room.game.revealedGoldenCableCount >= room.game.goldenCableTarget) {
      endGame(room, "Sherlock", serverText.enoughGoldenCables);
      emitRoomState(room);
      return;
    }
  } else {
    room.game.revealedNeutralCableCount += 1;
  }

  // --- GESTION DES TOURS ET MANCHES ---
  
  room.game.actionsRemainingInRound -= 1;

  if (room.game.actionsRemainingInRound <= 0) {
    // Si c'était la dernière action de la manche 4
    if (room.game.currentRound >= room.game.maxRounds) {
      endGame(room, "Moriarty", serverText.maxRoundsReached);
    } else {
      // Sinon, on passe à la manche suivante
      startRound(room, room.game.currentRound + 1, room.game.lastCutTargetId);
    }
  } else {
    // La manche continue, le tour passe à celui qui a été coupé
    room.game.currentCutterId = targetPlayer.id;
  }

  emitRoomState(room);
};

  const room = ensureRoom(socket.data.roomCode);
  if (!room) {
    return;
  }

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
    io.to(socket.id).emit("error:message", serverText.blockedTarget(targetPlayer.name));
    return;
  }

  const availableWires = targetPlayer.wires.filter((wire) => !wire.isRevealed);
  if (!availableWires.length) {
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
    revealedBy: actingPlayer.name,
    revealedAt: Date.now()
  };

  room.game.revealedCards.push(revealedCard);
  room.game.lastRevealed = revealedCard;
  room.game.lastCutTargetId = targetPlayer.id;
  room.game.blockedDrawTargets[targetPlayer.id] = actingPlayer.id;

  const ended = endGameIfNeeded(room, selectedWire.type);
  assertDeckIntegrity(room);

  if (!ended) {
    room.game.actionsRemainingInRound = Math.max(
      0,
      (room.game.actionsRemainingInRound ?? 0) - 1
    );

    if (room.game.blockedDrawTargets[actingPlayer.id]) {
      delete room.game.blockedDrawTargets[actingPlayer.id];
    }

    if (room.game.actionsRemainingInRound === 0) {
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

  if (!room || !player || !message.trim()) {
    return;
  }

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
