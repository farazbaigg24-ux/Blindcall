const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Fix 1: Proper Socket.IO config for Render
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  allowUpgrades: true,
  transports: ['websocket', 'polling'], // try websocket first, fallback to polling
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Fix 2: Keep-alive endpoint so Render never sleeps
app.get('/ping', (req, res) => res.json({ status: 'alive', users: io.engine.clientsCount, time: Date.now() }));

// Admin API — get all reports
app.get('/admin/reports', (req, res) => {
  const pin = req.query.pin;
  if (pin !== '2606') return res.status(401).json({ error: 'Unauthorized' });
  res.json({ reports, total: reports.length });
});

// Admin API — update report status
app.post('/admin/reports/:id/status', express.json(), (req, res) => {
  const pin = req.query.pin;
  if (pin !== '2606') return res.status(401).json({ error: 'Unauthorized' });
  const report = reports.find(r => r.id === parseInt(req.params.id));
  if (!report) return res.status(404).json({ error: 'Not found' });
  report.status = req.body.status;
  res.json({ ok: true, report });
});

// Admin API — maintenance mode toggle
app.post('/admin/maintenance', express.json(), (req, res) => {
  const pin = req.query.pin;
  if (pin !== '2606') return res.status(401).json({ error: 'Unauthorized' });
  maintenanceMode = req.body.active;
  console.log('🔧 Maintenance mode:', maintenanceMode ? 'ON' : 'OFF');
  // Broadcast to ALL connected users
  io.emit('maintenance', { active: maintenanceMode });
  res.json({ ok: true, active: maintenanceMode });
});

app.get('/admin/maintenance', (req, res) => {
  const pin = req.query.pin;
  if (pin !== '2606') return res.status(401).json({ error: 'Unauthorized' });
  res.json({ active: maintenanceMode });
});

// Admin API — get stats
app.get('/admin/stats', (req, res) => {
  const pin = req.query.pin;
  if (pin !== '2606') return res.status(401).json({ error: 'Unauthorized' });
  const newReports = reports.filter(r => r.status === 'new').length;
  const reasons = {};
  reports.forEach(r => { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
  res.json({
    total: reports.length,
    new: newReports,
    reviewed: reports.filter(r => r.status === 'reviewed').length,
    dismissed: reports.filter(r => r.status === 'dismissed').length,
    topReasons: Object.entries(reasons).sort((a,b)=>b[1]-a[1]).slice(0,5),
    online: io.engine.clientsCount,
    waiting: waitingUsers.length,
    activePairs: connectedPairs.size / 2,
  });
});

const waitingUsers = [];
const connectedPairs = new Map();

// ── Maintenance mode ──
let maintenanceMode = false;

// ── Reports store (in-memory, survives until server restart) ──
const reports = [];
const MAX_REPORTS = 500;

function addReport(report) {
  reports.unshift(report); // newest first
  if (reports.length > MAX_REPORTS) reports.pop();
}

function broadcastOnlineCount() {
  io.emit('online-count', io.engine.clientsCount);
}

// Fix 3: Clean up stale waiting users (disconnected but still in list)
function cleanWaitingList() {
  for (let i = waitingUsers.length - 1; i >= 0; i--) {
    const s = waitingUsers[i];
    if (!s.connected) {
      waitingUsers.splice(i, 1);
      console.log('Cleaned stale waiting user:', s.id);
    }
  }
}

io.on('connection', (socket) => {
  // Send maintenance state immediately on connect
  socket.emit('maintenance', { active: maintenanceMode });

  console.log('Connected:', socket.id, '| Online:', io.engine.clientsCount);
  broadcastOnlineCount();

  socket.on('join', ({ interests = [], region = 'anywhere' }) => {
    // Clean stale users first
    cleanWaitingList();

    // Remove self from waiting if already there (re-join case)
    const existingIdx = waitingUsers.findIndex(u => u.id === socket.id);
    if (existingIdx !== -1) waitingUsers.splice(existingIdx, 1);

    // Remove from any existing pair
    const oldPartner = connectedPairs.get(socket.id);
    if (oldPartner) {
      connectedPairs.delete(oldPartner);
      connectedPairs.delete(socket.id);
    }

    socket.interests = interests;
    socket.region = region;

    let bestMatch = null;
    let bestScore = -1;

    for (let i = 0; i < waitingUsers.length; i++) {
      const candidate = waitingUsers[i];
      if (candidate.id === socket.id) continue;
      if (!candidate.connected) continue; // skip disconnected

      const myRegion = socket.region || 'anywhere';
      const theirRegion = candidate.region || 'anywhere';
      const regionMatch = myRegion === 'anywhere' || theirRegion === 'anywhere' || myRegion === theirRegion;
      if (!regionMatch) continue;

      const shared = (candidate.interests || []).filter(i => (socket.interests || []).includes(i)).length;
      const regionBonus = (myRegion !== 'anywhere' && myRegion === theirRegion) ? 5 : 0;
      const totalScore = shared + regionBonus;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestMatch = { index: i, socket: candidate };
      }
    }

    if (bestMatch) {
      waitingUsers.splice(bestMatch.index, 1);
      const partner = bestMatch.socket;

      connectedPairs.set(socket.id, partner.id);
      connectedPairs.set(partner.id, socket.id);

      console.log(`Matched: ${socket.id} <-> ${partner.id}`);

      // Fix 4: Small delay so both sockets are fully ready before matched fires
      setTimeout(() => {
        socket.emit('matched', { partnerId: partner.id, isInitiator: true });
        // Fix 5: Slight extra delay for non-initiator so initiator sets up peer first
        setTimeout(() => {
          partner.emit('matched', { partnerId: socket.id, isInitiator: false });
        }, 300);
      }, 100);

    } else {
      if (!waitingUsers.find(u => u.id === socket.id)) {
        waitingUsers.push(socket);
        socket.emit('waiting');
        console.log('Waiting:', socket.id, '| Queue:', waitingUsers.length);
      }
    }
  });

  socket.on('signal', ({ to, signal }) => {
    // Fix 6: Verify the recipient is actually paired with sender
    const senderPartner = connectedPairs.get(socket.id);
    if (senderPartner !== to) {
      console.warn('Signal to wrong target blocked');
      return;
    }
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  socket.on('chat-message', ({ message }) => {
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('chat-message', { message });
  });

  socket.on('next', () => {
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('partner-disconnected');
      connectedPairs.delete(partnerId);
      connectedPairs.delete(socket.id);
    }
    const idx = waitingUsers.findIndex(u => u.id === socket.id);
    if (idx !== -1) waitingUsers.splice(idx, 1);
  });

  socket.on('leave', () => {
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) {
      connectedPairs.delete(partnerId);
      connectedPairs.delete(socket.id);
    }
    const idx = waitingUsers.findIndex(u => u.id === socket.id);
    if (idx !== -1) waitingUsers.splice(idx, 1);
  });

  socket.on('game-event', ({ to, game, data }) => {
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('game-event', { game, data });
  });

  socket.on('report', ({ reason }) => {
    const partnerId = connectedPairs.get(socket.id);
    console.log(`⚠️  REPORT: ${reason} | Reporter: ${socket.id} | Reported: ${partnerId}`);

    // Store report
    addReport({
      id: Date.now(),
      reason,
      reporterId: socket.id,
      reportedId: partnerId || 'unknown',
      timestamp: new Date().toISOString(),
      status: 'new', // new | reviewed | dismissed
    });

    // Broadcast to any admin watching
    io.emit('admin-report', { total: reports.length, latest: reports[0] });

    // Disconnect reported user
    if (partnerId) {
      io.to(partnerId).emit('partner-disconnected');
      connectedPairs.delete(partnerId);
      connectedPairs.delete(socket.id);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Disconnected:', socket.id, '|', reason);
    const idx = waitingUsers.findIndex(u => u.id === socket.id);
    if (idx !== -1) waitingUsers.splice(idx, 1);
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
  console.log(`Blindcall running on port ${PORT}`);
});
