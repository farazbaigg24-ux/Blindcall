const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Explicit routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const waitingUsers = [];
const connectedPairs = new Map();

function broadcastOnlineCount() {
  io.emit('online-count', io.engine.clientsCount);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  broadcastOnlineCount();

  socket.on('join', ({ interests = [] }) => {
    socket.interests = interests;

    // Try to find a match
    let bestMatch = null;
    let bestScore = -1;

    for (let i = 0; i < waitingUsers.length; i++) {
      const candidate = waitingUsers[i];
      if (candidate.id === socket.id) continue;

      // Score based on shared interests
      const shared = (candidate.interests || []).filter(i =>
        (socket.interests || []).includes(i)
      ).length;

      if (shared > bestScore) {
        bestScore = shared;
        bestMatch = { index: i, socket: candidate };
      }
    }

    if (bestMatch) {
      // Remove match from waiting list
      waitingUsers.splice(bestMatch.index, 1);
      const partner = bestMatch.socket;

      // Connect them
      connectedPairs.set(socket.id, partner.id);
      connectedPairs.set(partner.id, socket.id);

      socket.emit('matched', { partnerId: partner.id, isInitiator: true });
      partner.emit('matched', { partnerId: socket.id, isInitiator: false });
    } else {
      // Add to waiting list
      if (!waitingUsers.find(u => u.id === socket.id)) {
        waitingUsers.push(socket);
        socket.emit('waiting');
      }
    }
  });

  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  socket.on('chat-message', ({ message }) => {
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('chat-message', { message });
    }
  });

  socket.on('next', () => {
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('partner-disconnected');
      connectedPairs.delete(partnerId);
      connectedPairs.delete(socket.id);
    }
    // Remove from waiting if there
    const idx = waitingUsers.findIndex(u => u.id === socket.id);
    if (idx !== -1) waitingUsers.splice(idx, 1);
  });

  socket.on('leave', () => {
    const idx = waitingUsers.findIndex(u => u.id === socket.id);
    if (idx !== -1) waitingUsers.splice(idx, 1);
  });

  socket.on('report', ({ reason }) => {
    console.log(`Report filed: ${reason} against ${connectedPairs.get(socket.id)}`);
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('partner-disconnected');
      connectedPairs.delete(partnerId);
      connectedPairs.delete(socket.id);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    // Remove from waiting
    const idx = waitingUsers.findIndex(u => u.id === socket.id);
    if (idx !== -1) waitingUsers.splice(idx, 1);

    // Notify partner
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('partner-disconnected');
      connectedPairs.delete(partnerId);
      connectedPairs.delete(socket.id);
    }

    broadcastOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Blindcall server running on port ${PORT}`);
});
