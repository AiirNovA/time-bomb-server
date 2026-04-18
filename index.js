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
app.use(express.static(path.join(__dirname, 'dist')));

const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, avatarId }) => {
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    const room = {
      code,
      hostId: socket.id,
      players: [{ 
        id: socket.id, name, avatarId, role: null, wires: [], 
        connected: true, isHost: true
      }],
      game: { 
        status: 'waiting', round: 1, revealedCards: [], 
        currentCutterId: null, winner: null 
      },
      chat: []
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room:update', room);
  });

  socket.on('room:join', ({ name, code, avatarId }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.players.push({ 
      id: socket.id, name, avatarId, role: null, wires: [], 
      connected: true, isHost: false 
    });
    socket.join(code);
    io.to(code).emit('room:update', room);
  });

  socket.on('game:start', () => {
    const room = Array.from(rooms.values()).find(r => r.hostId === socket.id);
    if (!room) return;

    room.game.status = 'playing';
    room.game.currentCutterId = room.players[0].id;

    room.players.forEach(p => {
      // On utilise les termes standards que ton GameBoard comprend
      p.role = Math.random() > 0.5 ? 'Sherlock' : 'Moriarty';
      p.wires = [
        { id: Math.random().toString(), type: 'safe', revealed: false },
        { id: Math.random().toString(), type: 'gold', revealed: false },
        { id: Math.random().toString(), type: 'bomb', revealed: false }
      ];
    });

    io.to(room.code).emit('room:update', room);
  });

  socket.on('turn:cut', ({ targetPlayerId, wireId }) => {
    const room = Array.from(rooms.values()).find(r => r.players.some(p => p.id === socket.id));
    if (!room || room.game.status !== 'playing') return;

    const target = room.players.find(p => p.id === targetPlayerId);
    const wire = target?.wires.find(w => w.id === wireId);

    if (wire && !wire.revealed) {
      wire.revealed = true;
      room.game.revealedCards.push(wire);
      room.game.currentCutterId = target.id; // Le joueur coupé devient le coupeur

      if (wire.type === 'bomb') {
        room.game.status = 'ended';
        room.game.winner = 'Moriarty';
      } else if (room.game.revealedCards.filter(c => c.type === 'gold').length >= 3) {
        room.game.status = 'ended';
        room.game.winner = 'Sherlock';
      }

      io.to(room.code).emit('room:update', room);
    }
  });

  // Logique de chat et déconnexion identique...
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Live on ${PORT}`));