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

// In-memory game state
let lobbyCode = generatePin();
let hostSocketId = null;
let players = new Map(); // socketId -> { name, score, answeredAt, lastAnswerCorrect, lastAnswerTimeMs }
let questions = [];
let game = {
  status: 'idle', // idle | in-progress | showing-results | finished
  currentQuestionIndex: -1,
  questionEndsAt: null,
  fastestCorrect: null, // { socketId, name, timeMs }
  history: [] // per round stats
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

  socket.on('player:join', ({ name, code }) => {
    if (String(code) !== String(lobbyCode)) {
      return socket.emit('player:error', { message: 'Hibás PIN' });
    }
    if (players.size >= 50) {
      return socket.emit('player:error', { message: 'Betelt a szoba (max 50)' });
    }
    const cleanName = String(name || '').trim().slice(0, 20) || `Játékos${players.size+1}`;
    players.set(socket.id, { name: cleanName, score: 0, answeredAt: null, lastAnswerCorrect: false, lastAnswerTimeMs: null });
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
    const q = questions[game.currentQuestionIndex];
    if (!q) return;
  if (!game.questionEndsAt || Date.now() > game.questionEndsAt) return; // too late
  if (game.status !== 'in-progress') return; // round already ended

    // If already answered, ignore
    if (p.answeredAt && p.answeredAt.roundIndex === game.currentQuestionIndex) return;

    const correct = Number(choiceIndex) === q.correctIndex;
    const timeMs = Math.max(0, q.durationSeconds * 1000 - Math.max(0, game.questionEndsAt - Date.now()));

    p.answeredAt = { at: Date.now(), roundIndex: game.currentQuestionIndex };
    p.lastAnswerCorrect = correct;
    p.lastAnswerTimeMs = timeMs;
    if (correct) {
      p.score += 1; // base point
      // Track fastest correct
      const elapsed = q.durationSeconds * 1000 - (game.questionEndsAt - Date.now());
      if (!game.fastestCorrect || elapsed < game.fastestCorrect.timeMs) {
        game.fastestCorrect = { socketId: socket.id, name: p.name, timeMs: elapsed };
      }
    }

    const progress = roundProgress();
    io.emit('round:progress', progress);
    // If everyone answered, end early
    if (players.size > 0 && progress.answered >= players.size && game.status === 'in-progress') {
      endQuestion();
    }
  });

  socket.on('disconnect', () => {
    if (socket.id === hostSocketId) {
      hostSocketId = null;
    }
    if (players.has(socket.id)) {
      players.delete(socket.id);
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
  game.questionEndsAt = Date.now() + q.durationSeconds * 1000;

  // reset per-player round flags
  players.forEach(p => { p.answeredAt = null; p.lastAnswerCorrect = false; p.lastAnswerTimeMs = null; });

  io.emit('round:start', { index: game.currentQuestionIndex, total: questions.length, question: publicQuestion(q), endsAt: game.questionEndsAt });

  // Timer to auto close question
  setTimeout(() => {
    if (game.currentQuestionIndex < 0) return;
    if (Date.now() >= game.questionEndsAt) {
      endQuestion();
    }
  }, q.durationSeconds * 1000 + 50);
}

function endQuestion() {
  // finalize round and show results
  finalizeRound();
  game.status = 'showing-results';
  const endedIndex = game.currentQuestionIndex;
  io.emit('round:end', {
    index: game.currentQuestionIndex,
    correctIndex: questions[game.currentQuestionIndex]?.correctIndex,
    fastestCorrect: game.fastestCorrect,
    leaderboard: leaderboard()
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
    correctIndex: q.correctIndex,
    counts: [0,0,0,0],
    fastestCorrect: game.fastestCorrect
  };
  players.forEach(p => {
    if (Number.isInteger(p.lastAnswerTimeMs)) {
      // We didn't store which choice they picked; aggregate via correctness approximated not precise per choice.
    }
  });
  game.history.push(stats);
}

function roundProgress() {
  const answered = Array.from(players.values()).filter(p => p.answeredAt && p.answeredAt.roundIndex === game.currentQuestionIndex).length;
  const total = players.size;
  return { answered, total };
}

function publicPlayers() {
  return Array.from(players.entries()).map(([socketId, p]) => ({ id: socketId, name: p.name, score: p.score }));
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

function resetGame() {
  game = { status: 'idle', currentQuestionIndex: -1, questionEndsAt: null, fastestCorrect: null, history: [] };
  players.forEach(p => { p.score = 0; p.answeredAt = null; p.lastAnswerCorrect = false; p.lastAnswerTimeMs = null; });
}

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getLocalIPs() {
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
  const header = 'Name,Score\n';
  const rows = leaderboard().map(r => `${csvEsc(r.name)},${r.score}`);
  return header + rows.join('\n');
}

function csvEsc(s) {
  const str = String(s);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Elérhető LAN IP-k:', getLocalIPs().map(ip => `http://${ip}:${PORT}`).join(', '));
});
