import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// Servir les fichiers statiques du dossier 'dist'
app.use(express.static(path.join(__dirname, 'dist')));

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- LOGIQUE DU JEU ---
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Joueur connecté:', socket.id);

  socket.on('room:create', ({ name, avatarId }) => {
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name, avatarId, role: null, wires: [] }],
      game: { status: 'waiting', round: 1, cardsLeft: 0, revealedCards: [] },
      chat: []
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room:update', room);
  });

  socket.on('room:join', ({ name, code, avatarId }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('error:message', 'Salon introuvable');
    if (room.players.length >= 8) return socket.emit('error:message', 'Salon complet');
    
    room.players.push({ id: socket.id, name, avatarId, role: null, wires: [] });
    socket.join(code);
    io.to(code).emit('room:update', room);
  });

  socket.on('game:start', () => {
    const room = Array.from(rooms.values()).find(r => r.hostId === socket.id);
    if (!room) return;

    room.game.status = 'playing';
    room.game.round = 1;
    room.game.revealedCards = [];
    
    // Distribution simplifiée pour test
    room.players.forEach(p => {
      p.role = Math.random() > 0.5 ? 'Sherlock' : 'Moriarty';
      p.wires = [
        { id: Math.random(), type: 'safe', revealed: false },
        { id: Math.random(), type: 'safe', revealed: false }
      ];
    });

    io.to(room.code).emit('room:update', room);
    io.to(room.code).emit('notice', 'La partie commence !');
  });

  socket.on('chat:send', ({ message }) => {
    let targetRoom = null;
    rooms.forEach(r => {
      if (r.players.some(p => p.id === socket.id)) targetRoom = r;
    });

    if (targetRoom) {
      const sender = targetRoom.players.find(p => p.id === socket.id);
      const chatMsg = {
        id: Date.now(),
        senderName: sender.name,
        senderId: socket.id,
        text: message
      };
      targetRoom.chat.push(chatMsg);
      if (targetRoom.chat.length > 50) targetRoom.chat.shift();
      io.to(targetRoom.code).emit('room:update', targetRoom);
    }
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, code) => {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        rooms.delete(code);
      } else {
        io.to(code).emit('room:update', room);
      }
    });
  });
});

// Redirection vers l'index pour le SPA (Single Page Application)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Serveur opérationnel sur le port ${PORT}`);
});