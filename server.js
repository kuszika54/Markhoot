import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const RESULTS_AUTO_ADVANCE_MS = 3000; // time to show results before next question

// Host-configurable settings
let settings = {
  teamMode: false,
  shuffleChoices: true,
  baseDuration: 30
};

// In-memory game state
let lobbyCode = generatePin();
let hostSocketId = null;
let players = new Map(); // socketId -> { name, score, team, answeredAt, lastAnswerCorrect, lastAnswerTimeMs, streak }
let questions = [];
let game = {
  status: 'idle', // idle | in-progress | showing-results | finished
  currentQuestionIndex: -1,
  questionEndsAt: null,
  fastestCorrect: null, // { socketId, name, timeMs }
  history: [], // per round stats
  currentDisplay: null, // per-round shuffled question for display { text, choices, durationSeconds, correctIndex }
  counts: [0,0,0,0],
  paused: false,
  remainingMs: null,
  answers: [], // per-answer details { q: index, socketId, name, choiceIndex, correct, timeMs, team }
  roundParticipants: null // Set of socketIds present at round start
};

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// Views
app.get('/', (_req, res) => res.redirect('/host'));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public/host.html')));
app.get('/player', (_req, res) => res.sendFile(path.join(__dirname, 'public/player.html')));
app.get('/builder', (_req, res) => res.sendFile(path.join(__dirname, 'public/builder.html')));

// Questions management
app.get('/api/questions', (_req, res) => {
  res.json(questions);
});

app.post('/api/questions', (req, res) => {
  const body = req.body;
  if (!Array.isArray(body)) return res.status(400).json({ error: 'Array of questions expected' });
  // Basic validation
  const ok = body.every(q => q && typeof q.text === 'string' && Array.isArray(q.choices) && q.choices.length === 4 && Number.isInteger(q.correctIndex));
  if (!ok) return res.status(400).json({ error: 'Invalid question format' });
  questions = body.map((q, idx) => ({ id: q.id || `q${idx+1}`, durationSeconds: 30, ...q }));
  resetGame();
  io.emit('questions:loaded', { count: questions.length });
  res.json({ ok: true, count: questions.length });
});

app.get('/api/lobby', (_req, res) => {
  res.json({ lobbyCode, port: PORT, ips: getLocalIPs() });
});

app.get('/api/export.csv', (_req, res) => {
  const csv = exportCSV();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
  res.send(csv);
});

// Serve sample questions for the builder UI
app.get('/api/sample-questions', (_req, res) => {
  try {
    const p = path.join(__dirname, 'questions.sample.json');
    const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
    res.json(arr);
  } catch (e) {
    res.status(404).json({ error: 'Sample not found' });
  }
});

app.get('/api/join-qr', async (req, res) => {
  const ips = getLocalIPs();
  const base = ips[0] ? `http://${ips[0]}:${PORT}` : `http://localhost:${PORT}`;
  const url = `${base}/player?pin=${encodeURIComponent(lobbyCode)}`;
  try {
    const png = await QRCode.toBuffer(url, { type: 'png', margin: 1, width: 256 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(500).send('QR error');
  }
});

io.on('connection', (socket) => {
  // Identify role
  socket.on('host:hello', () => {
    hostSocketId = socket.id;
    socket.emit('lobby:update', { lobbyCode, ips: getLocalIPs(), port: PORT });
    io.to(socket.id).emit('questions:loaded', { count: questions.length });
    // Sync game state
    io.to(socket.id).emit('game:state', publicGameState());
  });

  socket.on('player:join', ({ name, code, team }) => {
    if (String(code) !== String(lobbyCode)) {
      return socket.emit('player:error', { message: 'Hibás PIN' });
    }
    if (players.size >= 50) {
      return socket.emit('player:error', { message: 'Betelt a szoba (max 50)' });
    }
    let cleanName = String(name || '').trim().slice(0, 20) || `Játékos${players.size+1}`;
    // ensure unique name
    const existing = new Set(Array.from(players.values()).map(p => p.name));
    if (existing.has(cleanName)) {
      let i = 2;
      while (existing.has(`${cleanName} (${i})`)) i++;
      cleanName = `${cleanName} (${i})`;
    }
    let assignedTeam = null;
    if (settings.teamMode) {
      const allowed = ['piros','kék','zöld','sárga'];
      if (allowed.includes(team)) assignedTeam = team; else {
        // auto-balance teams
        const counts = { piros:0, kék:0, zöld:0, sárga:0 };
        players.forEach(p => { if (p.team && counts[p.team] !== undefined) counts[p.team]++; });
        assignedTeam = Object.entries(counts).sort((a,b)=>a[1]-b[1])[0][0];
      }
    }
    players.set(socket.id, { name: cleanName, score: 0, team: assignedTeam, answeredAt: null, lastAnswerCorrect: false, lastAnswerTimeMs: null, streak: 0 });
    socket.emit('player:joined', { name: cleanName });
    io.emit('lobby:players', publicPlayers());
  });

  socket.on('host:start', () => {
    if (!isHost(socket)) return;
    if (!questions.length) return io.to(socket.id).emit('host:error', { message: 'Nincsenek kérdések' });
    resetGame();
    game.status = 'in-progress';
    game.currentQuestionIndex = -1;
    io.emit('game:state', publicGameState());
    nextQuestion();
  });

  socket.on('host:next', () => {
    if (!isHost(socket)) return;
    if (game.status !== 'in-progress' && game.status !== 'showing-results') return;
    nextQuestion();
  });

  socket.on('host:set-settings', (newSettings) => {
    if (!isHost(socket)) return;
    settings = { ...settings, ...pick(newSettings, ['teamMode','shuffleChoices','baseDuration']) };
    io.emit('settings:update', settings);
  });

  socket.on('host:pause', () => {
    if (!isHost(socket)) return;
    if (game.status !== 'in-progress' || game.paused) return;
    game.paused = true;
    game.remainingMs = Math.max(0, (game.questionEndsAt || Date.now()) - Date.now());
    game.questionEndsAt = null;
    io.emit('round:paused');
  });

  socket.on('host:resume', () => {
    if (!isHost(socket)) return;
    if (game.status !== 'in-progress' || !game.paused) return;
    game.paused = false;
    game.questionEndsAt = Date.now() + (game.remainingMs || 0);
    io.emit('round:resumed', { endsAt: game.questionEndsAt });
  // emit progress after resume and rely on watchdog + primary timeout
  io.emit('round:progress', roundProgress());
  });

  socket.on('host:kick', ({ socketId }) => {
    if (!isHost(socket)) return;
    const s = io.sockets.sockets.get(socketId);
    if (s) s.disconnect(true);
  });

  socket.on('host:reset-pin', () => {
    if (!isHost(socket)) return;
    lobbyCode = generatePin();
    io.emit('lobby:update', { lobbyCode, ips: getLocalIPs(), port: PORT });
  });

  socket.on('host:load-sample', () => {
    if (!isHost(socket)) return;
    const p = path.join(__dirname, 'questions.sample.json');
    try {
      const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
      questions = arr.map((q, idx) => ({ id: q.id || `q${idx+1}`, durationSeconds: 30, ...q }));
      resetGame();
      io.emit('questions:loaded', { count: questions.length });
    } catch (e) {
      io.to(socket.id).emit('host:error', { message: 'Minta kérdések betöltése sikertelen' });
    }
  });

  socket.on('player:answer', ({ choiceIndex }) => {
    const p = players.get(socket.id);
    if (!p) return;
    const disp = game.currentDisplay;
    if (!disp) return;
    if (game.paused) return; // paused, ignore
    if (!game.questionEndsAt || Date.now() > game.questionEndsAt) return; // too late
    if (game.status !== 'in-progress') return; // round already ended

    // If already answered, ignore
    if (p.answeredAt && p.answeredAt.roundIndex === game.currentQuestionIndex) return;

  const correct = Number(choiceIndex) === disp.correctIndex;
  const now = Date.now();
  const elapsed = Math.max(0, (disp.durationSeconds * 1000) - Math.max(0, (game.questionEndsAt - now)));
  const timeMs = elapsed;

    p.answeredAt = { at: Date.now(), roundIndex: game.currentQuestionIndex };
    p.lastAnswerCorrect = correct;
    p.lastAnswerTimeMs = timeMs;
    if (correct) {
      p.score += 1; // base point
      p.streak = (p.streak || 0) + 1;
      if (p.streak >= 3) p.score += 0.5; // streak bonus
      // Track fastest correct
      if (!game.fastestCorrect || elapsed < game.fastestCorrect.timeMs) {
        game.fastestCorrect = { socketId: socket.id, name: p.name, timeMs: elapsed };
      }
    } else {
      p.streak = 0;
    }

    // track counts and answers
    game.counts[choiceIndex] = (game.counts[choiceIndex] || 0) + 1;
    game.answers.push({ q: game.currentQuestionIndex, socketId: socket.id, name: p.name, choiceIndex, correct, timeMs, team: p.team });

  const progress = roundProgress();
    io.emit('round:progress', progress);
    io.emit('round:counts', { counts: game.counts });
  // If all round participants answered, end early
  if (progress.total > 0 && progress.answered >= progress.total && game.status === 'in-progress') {
      endQuestion();
    }
  });

  socket.on('disconnect', () => {
    if (socket.id === hostSocketId) {
      hostSocketId = null;
    }
    if (players.has(socket.id)) {
      players.delete(socket.id);
      // If player was part of current round participants, remove and re-evaluate progress
      if (game.roundParticipants && game.roundParticipants.has(socket.id)) {
        game.roundParticipants.delete(socket.id);
        if (game.status === 'in-progress') {
          const progress = roundProgress();
          io.emit('round:progress', progress);
          if (progress.total > 0 && progress.answered >= progress.total) endQuestion();
        }
      }
      io.emit('lobby:players', publicPlayers());
    }
  });
});

function isHost(socket) {
  return socket.id === hostSocketId;
}

function nextQuestion() {
  // tally previous round bonus and history
  if (game.currentQuestionIndex >= 0) finalizeRound();

  game.currentQuestionIndex += 1;
  game.fastestCorrect = null;

  if (game.currentQuestionIndex >= questions.length) {
    game.status = 'finished';
    io.emit('game:state', publicGameState());
    io.emit('game:final', { leaderboard: leaderboard() });
    return;
  }

  const q = questions[game.currentQuestionIndex];
  game.status = 'in-progress';
  const duration = (settings.baseDuration && Number.isFinite(settings.baseDuration)) ? Number(settings.baseDuration) : (q.durationSeconds || 30);
  // shuffle choices if enabled
  let display = { text: q.text, choices: q.choices.slice(), durationSeconds: duration, correctIndex: q.correctIndex };
  if (settings.shuffleChoices) {
    const idx = [0,1,2,3];
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    display.choices = idx.map(i => q.choices[i]);
    display.correctIndex = idx.indexOf(q.correctIndex);
  }
  game.currentDisplay = display;
  game.questionEndsAt = Date.now() + display.durationSeconds * 1000;
  game.paused = false;
  game.remainingMs = null;
  game.counts = [0,0,0,0];
  // Snapshot round participants (only players present at start count toward early-end)
  game.roundParticipants = new Set(Array.from(players.keys()));

  // reset per-player round flags
  players.forEach(p => { p.answeredAt = null; p.lastAnswerCorrect = false; p.lastAnswerTimeMs = null; });

  io.emit('round:start', { index: game.currentQuestionIndex, total: questions.length, question: publicQuestion(game.currentDisplay), endsAt: game.questionEndsAt });
  // Emit initial progress so host shows 0/N
  io.emit('round:progress', roundProgress());

  // Timer to auto close question (primary timeout)
  setTimeout(() => {
    if (game.currentQuestionIndex < 0) return;
    if (!game.paused && Date.now() >= (game.questionEndsAt || 0)) {
      endQuestion();
    }
  }, display.durationSeconds * 1000 + 50);

  // Watchdog: in case of clock skew or missed timeout, poll every 500ms
  if (game._watchdog) clearInterval(game._watchdog);
  game._watchdog = setInterval(() => {
    if (game.status !== 'in-progress') return; 
    if (!game.paused && Date.now() >= (game.questionEndsAt || 0)) {
      clearInterval(game._watchdog);
      endQuestion();
    }
  }, 500);
}

function endQuestion() {
  if (game.status !== 'in-progress') return; // already ended or not in a question
  if (game._watchdog) { clearInterval(game._watchdog); game._watchdog = null; }
  // finalize round and show results
  finalizeRound();
  game.status = 'showing-results';
  const endedIndex = game.currentQuestionIndex;
  io.emit('round:end', {
    index: game.currentQuestionIndex,
  correctIndex: game.currentDisplay?.correctIndex,
    fastestCorrect: game.fastestCorrect,
  leaderboard: leaderboard(),
  teamboard: settings.teamMode ? teamLeaderboard() : null,
  counts: game.counts
  });
  // Auto-advance after a short delay
  setTimeout(() => {
    if (game.status === 'showing-results' && game.currentQuestionIndex === endedIndex) {
      nextQuestion();
    }
  }, RESULTS_AUTO_ADVANCE_MS);
}

function finalizeRound() {
  const q = questions[game.currentQuestionIndex];
  if (!q) return;
  // bonus 0.5 for fastest correct
  if (game.fastestCorrect && players.has(game.fastestCorrect.socketId)) {
    const p = players.get(game.fastestCorrect.socketId);
    p.score += 0.5;
  }
  // save round stats
  const stats = {
    index: game.currentQuestionIndex,
  correctIndex: game.currentDisplay?.correctIndex ?? q.correctIndex,
  counts: game.counts.slice(),
    fastestCorrect: game.fastestCorrect
  };
  game.history.push(stats);
}

function roundProgress() {
  const participants = game.roundParticipants ? Array.from(game.roundParticipants) : Array.from(players.keys());
  const answered = participants.filter(id => {
    const p = players.get(id);
    return p && p.answeredAt && p.answeredAt.roundIndex === game.currentQuestionIndex;
  }).length;
  const total = participants.length;
  return { answered, total };
}

function publicPlayers() {
  return Array.from(players.entries()).map(([socketId, p]) => ({ id: socketId, name: p.name, score: p.score, team: p.team }));
}

function publicQuestion(q) {
  return { text: q.text, choices: q.choices, durationSeconds: q.durationSeconds };
}

function publicGameState() {
  return {
    status: game.status,
    currentQuestionIndex: game.currentQuestionIndex,
    totalQuestions: questions.length,
    questionEndsAt: game.questionEndsAt,
    leaderboard: leaderboard()
  };
}

function leaderboard() {
  return Array.from(players.values())
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
}

function teamLeaderboard() {
  const sums = {};
  players.forEach(p => { if (p.team) sums[p.team] = (sums[p.team] || 0) + p.score; });
  return Object.entries(sums).map(([team, score]) => ({ team, score })).sort((a,b)=>b.score-a.score);
}

function resetGame() {
  if (game._watchdog) { try { clearInterval(game._watchdog); } catch {} }
  game = {
    status: 'idle',
    currentQuestionIndex: -1,
    questionEndsAt: null,
    fastestCorrect: null,
    history: [],
    currentDisplay: null,
    counts: [0,0,0,0],
    paused: false,
    remainingMs: null,
    answers: [],
    roundParticipants: null,
    _watchdog: null
  };
  players.forEach(p => { p.score = 0; p.answeredAt = null; p.lastAnswerCorrect = false; p.lastAnswerTimeMs = null; });
}

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getLocalIPs() {
  // If running in Docker with bridge network, use the HOST_IP environment variable
  if (process.env.HOST_NETWORK && process.env.HOST_IP) {
    return [process.env.HOST_IP];
  }
  
  // If running in Docker but no HOST_IP set, try to detect
  if (process.env.HOST_NETWORK) {
    try {
      const nets = os.networkInterfaces();
      const results = [];
      
      // Look for the docker bridge gateway (usually the host IP from container perspective)
      if (nets.eth0) {
        const gateway = nets.eth0.find(net => net.family === 'IPv4' && !net.internal);
        if (gateway) {
          // Extract host IP from container's gateway (usually .1)
          const parts = gateway.address.split('.');
          if (parts.length === 4) {
            const hostIP = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
            results.push(hostIP);
          }
        }
      }
      
      // Fallback to a reasonable default
      if (results.length === 0) {
        results.push('10.36.10.20'); // Your actual host IP as fallback
      }
      
      return results;
    } catch (error) {
      console.log('Could not determine host IP, using fallback');
      return ['10.36.10.20']; // Your actual host IP as fallback
    }
  }
  
  // Original implementation for non-Docker environments
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) results.push(net.address);
    }
  }
  return results;
}

function exportCSV() {
  const totalQ = questions.length;
  const playersArr = Array.from(players.values()).map(p => p.name);
  // Build per player per question answers
  const byPlayer = new Map();
  players.forEach((p, id) => byPlayer.set(id, { name: p.name, score: p.score, answers: Array(totalQ).fill(null), times: Array(totalQ).fill(null), teams: p.team }));
  game.answers.forEach(a => {
    const entry = byPlayer.get(a.socketId);
    if (entry && a.q >= 0 && a.q < totalQ) {
      entry.answers[a.q] = a.choiceIndex;
      entry.times[a.q] = a.timeMs;
    }
  });
  const letters = ['A','B','C','D'];
  let header = ['Name','Team','Score'];
  for (let i=0;i<totalQ;i++) header.push(`Q${i+1} Ans`, `Q${i+1} TimeMs`);
  const lines = [header.join(',')];
  byPlayer.forEach((entry) => {
    const row = [csvEsc(entry.name), csvEsc(entry.teams||''), entry.score];
    for (let i=0;i<totalQ;i++) {
      const ans = entry.answers[i];
      row.push(ans == null ? '' : letters[ans]);
      row.push(entry.times[i] == null ? '' : entry.times[i]);
    }
    lines.push(row.join(','));
  });
  return lines.join('\n');
}

function csvEsc(s) {
  const str = String(s);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function pick(obj, keys) {
  const out = {};
  keys.forEach(k => { if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]; });
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`HOST_NETWORK env: ${process.env.HOST_NETWORK}`);
  console.log(`HOST_IP env: ${process.env.HOST_IP}`);
  const ips = getLocalIPs();
  console.log('Detected IPs:', ips);
  console.log('Elérhető LAN IP-k:', ips.map(ip => `http://${ip}:${PORT}`).join(', '));
});
