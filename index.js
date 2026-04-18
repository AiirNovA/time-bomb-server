import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.static(path.join(__dirname, 'dist')));

const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, avatarId }) => {
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    const room = {
      code, hostId: socket.id,
      players: [{ id: socket.id, name, avatarId, role: null, wires: [], connected: true }],
      game: { status: 'waiting', revealedCards: [], currentCutterId: null },
      chat: []
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room:update', room);
  });

  socket.on('room:join', ({ name, code, avatarId }) => {
    const room = rooms.get(code);
    if (room) {
      room.players.push({ id: socket.id, name, avatarId, role: null, wires: [], connected: true });
      socket.join(code);
      io.to(code).emit('room:update', room);
    }
  });

  socket.on('game:start', () => {
    const room = Array.from(rooms.values()).find(r => r.hostId === socket.id);
    if (!room) return;

    console.log("--- LANCEMENT DE LA PARTIE ---");
    room.game.status = 'playing';
    room.game.currentCutterId = socket.id;

    room.players.forEach(p => {
      p.role = 'Sherlock'; // Test forcé
      p.wires = [
        { id: 'w1-'+p.id, type: 'gold', revealed: false },
        { id: 'w2-'+p.id, type: 'safe', revealed: false },
        { id: 'w3-'+p.id, type: 'bomb', revealed: false }
      ];
    });

    console.log("Données envoyées :", JSON.stringify(room.game));
    io.to(room.code).emit('room:update', room);
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Diagnostic Server Running"));