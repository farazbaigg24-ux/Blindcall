const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  allowUpgrades: true,
  transports: ['websocket', 'polling'],
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'public', 'manifest.json')));
app.get('/sw.js', (req, res) => { res.setHeader('Service-Worker-Allowed', '/'); res.sendFile(path.join(__dirname, 'public', 'sw.js')); });
app.get('/offline.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'offline.html')));
app.get('/.well-known/assetlinks.json', (req, res) => res.sendFile(path.join(__dirname, 'public', '.well-known', 'assetlinks.json')));
app.get('/ping', (req, res) => res.json({ status: 'alive', users: io.engine.clientsCount, time: Date.now() }));

// MONGODB
const MONGO_URI = 'mongodb+srv://blindcall:Blindcall%4024@cluster0.au2at49.mongodb.net/blindcall?appName=Cluster0&retryWrites=true&w=majority';
let reportsCollection = null;
let memReports = [];

async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db('blindcall');
    reportsCollection = db.collection('reports');
    console.log('MongoDB connected');
  } catch(e) {
    console.warn('MongoDB failed, using memory fallback:', e.message);
  }
}
connectDB();

async function saveReport(report) {
  if (reportsCollection) { await reportsCollection.insertOne(report); }
  else { memReports.unshift(report); if (memReports.length > 500) memReports.pop(); }
}
async function getReports() {
  if (reportsCollection) return await reportsCollection.find({}).sort({ timestamp: -1 }).limit(500).toArray();
  return memReports;
}
async function updateReportStatus(id, status) {
  if (reportsCollection) { await reportsCollection.updateOne({ id }, { $set: { status } }); }
  else { const r = memReports.find(r => r.id === id); if (r) r.status = status; }
}

// APP STATE
const waitingUsers = [];
const connectedPairs = new Map();
let maintenanceMode = false;

function broadcastOnlineCount() { io.emit('online-count', io.engine.clientsCount); }
function cleanWaitingList() {
  for (let i = waitingUsers.length - 1; i >= 0; i--)
    if (!waitingUsers[i].connected) waitingUsers.splice(i, 1);
}

// SOCKET.IO
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  socket.emit('maintenance', { active: maintenanceMode });
  broadcastOnlineCount();

  socket.on('join', ({ interests = [], region = 'anywhere' }) => {
    cleanWaitingList();
    const existingIdx = waitingUsers.findIndex(u => u.id === socket.id);
    if (existingIdx !== -1) waitingUsers.splice(existingIdx, 1);
    const oldPartner = connectedPairs.get(socket.id);
    if (oldPartner) { connectedPairs.delete(oldPartner); connectedPairs.delete(socket.id); }
    socket.interests = interests;
    socket.region = region;

    let bestMatch = null, bestScore = -1;
    for (let i = 0; i < waitingUsers.length; i++) {
      const candidate = waitingUsers[i];
      if (candidate.id === socket.id || !candidate.connected) continue;
      const myRegion = socket.region || 'anywhere';
      const theirRegion = candidate.region || 'anywhere';
      const regionMatch = myRegion === 'anywhere' || theirRegion === 'anywhere' || myRegion === theirRegion;
      if (!regionMatch) continue;
      const shared = (candidate.interests || []).filter(i => (socket.interests || []).includes(i)).length;
      const regionBonus = (myRegion !== 'anywhere' && myRegion === theirRegion) ? 5 : 0;
      const totalScore = shared + regionBonus;
      if (totalScore > bestScore) { bestScore = totalScore; bestMatch = { index: i, socket: candidate }; }
    }

    if (bestMatch) {
      waitingUsers.splice(bestMatch.index, 1);
      const partner = bestMatch.socket;
      connectedPairs.set(socket.id, partner.id);
      connectedPairs.set(partner.id, socket.id);
      console.log('Matched:', socket.id, '<->', partner.id);
      setTimeout(() => {
        socket.emit('matched', { partnerId: partner.id, isInitiator: true });
        setTimeout(() => { partner.emit('matched', { partnerId: socket.id, isInitiator: false }); }, 300);
      }, 100);
    } else {
      if (!waitingUsers.find(u => u.id === socket.id)) {
        waitingUsers.push(socket);
        socket.emit('waiting');
      }
    }
  });

  socket.on('signal', ({ to, signal }) => {
    if (connectedPairs.get(socket.id) !== to) return;
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  socket.on('chat-message', ({ message }) => {
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('chat-message', { message });
  });

  socket.on('next', () => {
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) { io.to(partnerId).emit('partner-disconnected'); connectedPairs.delete(partnerId); connectedPairs.delete(socket.id); }
    const idx = waitingUsers.findIndex(u => u.id === socket.id);
    if (idx !== -1) waitingUsers.splice(idx, 1);
  });

  socket.on('leave', () => {
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) { connectedPairs.delete(partnerId); connectedPairs.delete(socket.id); }
    const idx = waitingUsers.findIndex(u => u.id === socket.id);
    if (idx !== -1) waitingUsers.splice(idx, 1);
  });

  socket.on('game-event', ({ to, game, data }) => {
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('game-event', { game, data });
  });

  socket.on('report', async ({ reason }) => {
    const partnerId = connectedPairs.get(socket.id);
    console.log('REPORT:', reason, '| by:', socket.id, '| against:', partnerId);
    const report = {
      id: Date.now(),
      reason,
      reporterId: socket.id,
      reportedId: partnerId || 'unknown',
      timestamp: new Date().toISOString(),
      status: 'new',
    };
    await saveReport(report);
    const allReports = await getReports();
    io.emit('admin-report', { total: allReports.length, latest: report });
    if (partnerId) {
      io.to(partnerId).emit('partner-disconnected');
      connectedPairs.delete(partnerId);
      connectedPairs.delete(socket.id);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Disconnected:', socket.id, reason);
    const idx = waitingUsers.findIndex(u => u.id === socket.id);
    if (idx !== -1) waitingUsers.splice(idx, 1);
    const partnerId = connectedPairs.get(socket.id);
    if (partnerId) { io.to(partnerId).emit('partner-disconnected'); connectedPairs.delete(partnerId); connectedPairs.delete(socket.id); }
    broadcastOnlineCount();
  });
});

// ADMIN ROUTES
const PIN = '2606';
app.get('/admin/reports', async (req, res) => {
  if (req.query.pin !== PIN) return res.status(401).json({ error: 'Unauthorized' });
  const reports = await getReports();
  res.json({ reports, total: reports.length });
});
app.post('/admin/reports/:id/status', async (req, res) => {
  if (req.query.pin !== PIN) return res.status(401).json({ error: 'Unauthorized' });
  await updateReportStatus(parseInt(req.params.id), req.body.status);
  res.json({ ok: true });
});
app.get('/admin/stats', async (req, res) => {
  if (req.query.pin !== PIN) return res.status(401).json({ error: 'Unauthorized' });
  const reports = await getReports();
  const reasons = {};
  reports.forEach(r => { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
  res.json({
    total: reports.length,
    new: reports.filter(r => r.status === 'new').length,
    reviewed: reports.filter(r => r.status === 'reviewed').length,
    dismissed: reports.filter(r => r.status === 'dismissed').length,
    topReasons: Object.entries(reasons).sort((a,b) => b[1]-a[1]).slice(0,5),
    online: io.engine.clientsCount,
    waiting: waitingUsers.length,
    activePairs: connectedPairs.size / 2,
    dbConnected: !!reportsCollection,
  });
});
app.post('/admin/maintenance', (req, res) => {
  if (req.query.pin !== PIN) return res.status(401).json({ error: 'Unauthorized' });
  maintenanceMode = req.body.active;
  io.emit('maintenance', { active: maintenanceMode });
  console.log('Maintenance:', maintenanceMode ? 'ON' : 'OFF');
  res.json({ ok: true, active: maintenanceMode });
});
app.get('/admin/maintenance', (req, res) => {
  if (req.query.pin !== PIN) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ active: maintenanceMode });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Blindcall running on port', PORT));
