const socket = io();

// identify as host
socket.emit('host:hello');

const lobbyInfo = document.getElementById('lobbyInfo');
const playersEl = document.getElementById('players');
const gameStateEl = document.getElementById('gameState');
const questionEl = document.getElementById('question');
const progressEl = document.getElementById('progress');
const btnStart = document.getElementById('btnStart');
const btnNext = document.getElementById('btnNext');
const btnResetPin = document.getElementById('btnResetPin');
const btnLoadSample = document.getElementById('btnLoadSample');
const btnExport = document.getElementById('btnExport');
const fileQuestions = document.getElementById('fileQuestions');
const btnUpload = document.getElementById('btnUpload');
const pinEl = document.getElementById('pin');
const ipsEl = document.getElementById('ips');
const joinUrlEl = document.getElementById('joinUrl');
const timebar = document.getElementById('timebarHost');
const finalCard = document.getElementById('finalCard');
const setTeam = document.getElementById('setTeam');
const setShuffle = document.getElementById('setShuffle');
const setDuration = document.getElementById('setDuration');
const btnApplySettings = document.getElementById('btnApplySettings');
const btnPause = document.getElementById('btnPause');
const btnResume = document.getElementById('btnResume');
const chart = document.getElementById('chart');
const final1Name = document.getElementById('final1Name');
const final1Score = document.getElementById('final1Score');
const final2Name = document.getElementById('final2Name');
const final2Score = document.getElementById('final2Score');
const final3Name = document.getElementById('final3Name');
const final3Score = document.getElementById('final3Score');

let currentEndsAt = null;
let timerInterval = null;

function renderLobby({ lobbyCode, ips, port }) {
  pinEl.textContent = lobbyCode;
  ipsEl.textContent = ips.join(', ');
  const url = ips.length ? `http://${ips[0]}:${port}/player` : `http://localhost:${port}/player`;
  joinUrlEl.textContent = url;
  lobbyInfo.textContent = `Csatlakozz: ${url} | PIN: ${lobbyCode}`;
}

function renderPlayers(list) {
  playersEl.innerHTML = '';
  list.forEach(p => {
    const li = document.createElement('li');
  const teamTxt = p.team ? ` [${p.team}]` : '';
  li.textContent = `${p.name}${teamTxt} — ${p.score} pont`;
  const kick = document.createElement('button');
  kick.textContent = 'Kick';
  kick.style.marginLeft = '8px';
  kick.onclick = () => socket.emit('host:kick', { socketId: p.id });
  li.appendChild(kick);
    playersEl.appendChild(li);
  });
}

function renderGameState(state) {
  gameStateEl.textContent = `Állapot: ${state.status} | Kérdés: ${state.currentQuestionIndex + 1}/${state.totalQuestions}`;
}

function renderQuestion(payload) {
  if (!payload) { questionEl.innerHTML = ''; return; }
  const q = payload.question;
  questionEl.innerHTML = `
    <div><strong>${payload.index+1}. kérdés / ${payload.total}</strong></div>
    <div class="question">${q.text}</div>
    <div class="choices">
      ${q.choices.map((c,i)=>`<div class="choice">${String.fromCharCode(65+i)}. ${c}</div>`).join('')}
    </div>
  `;
  currentEndsAt = payload.endsAt;
  startTimer();
}

function startTimer() {
  stopTimer();
  timerInterval = setInterval(()=>{
    if (!currentEndsAt) return;
    const ms = Math.max(0, currentEndsAt - Date.now());
    const sec = Math.ceil(ms/1000);
    progressEl.textContent = `Hátralévő idő: ${sec} mp`;
    if (timebar && questionEl.innerHTML) {
      const total = Math.max(1, sec); // approximate; visual only
      const qLeft = Math.max(0, ms);
      const pct = Math.max(0, Math.min(100, (qLeft / (qLeft + 1)) * 100));
      timebar.style.width = `${pct}%`;
    }
    if (ms <= 0) stopTimer();
  }, 250);
}
function stopTimer(){ if (timerInterval) clearInterval(timerInterval); timerInterval = null; }

// Socket handlers
socket.on('lobby:update', renderLobby);

socket.on('lobby:players', renderPlayers);

socket.on('questions:loaded', ({ count }) => {
  document.title = `Host | ${count} kérdés`;
});

socket.on('game:state', (s) => {
  renderGameState(s);
});

socket.on('round:start', (p)=>{
  renderGameState({ status: 'in-progress', currentQuestionIndex: p.index, totalQuestions: p.total });
  renderQuestion(p);
  renderCounts([0,0,0,0]);
});

socket.on('round:progress', (p)=>{
  const done = p.total > 0 && p.answered >= p.total;
  progressEl.textContent = `Válaszok: ${p.answered}/${p.total}` + (done ? ' — mindenki válaszolt, lezárás...' : '');
});

socket.on('round:counts', ({ counts }) => {
  renderCounts(counts);
});

socket.on('round:paused', () => {
  stopTimer();
  currentEndsAt = null;
  progressEl.textContent = 'Szünet';
});

socket.on('round:resumed', ({ endsAt }) => {
  currentEndsAt = endsAt;
  startTimer();
});

socket.on('round:end', ({ index, correctIndex, fastestCorrect, leaderboard, teamboard })=>{
  stopTimer();
  currentEndsAt = null;
  const fastestText = fastestCorrect ? `Leggyorsabb: ${fastestCorrect.name} (${(fastestCorrect.timeMs/1000).toFixed(2)} mp)` : 'Nem volt helyes gyors válasz';
  questionEl.innerHTML += `<div class="status">Helyes: ${String.fromCharCode(65+correctIndex)} | ${fastestText}</div>`;
  renderLeaderboard(leaderboard);
  if (teamboard && teamboard.length) {
    const teamHtml = teamboard.map((t,i)=>`<div>#${i+1} ${t.team}: ${t.score} pont</div>`).join('');
    gameStateEl.innerHTML += `<div style="margin-top:8px"><strong>Csapat ranglista</strong><div>${teamHtml}</div></div>`;
  }
});

socket.on('game:final', ({ leaderboard }) => {
  renderLeaderboard(leaderboard);
  // Show top3 podium
  const top = leaderboard.slice(0,3);
  if (top[0]) { final1Name.textContent = top[0].name; final1Score.textContent = `${top[0].score} pont`; }
  if (top[1]) { final2Name.textContent = top[1].name; final2Score.textContent = `${top[1].score} pont`; }
  if (top[2]) { final3Name.textContent = top[2].name; final3Score.textContent = `${top[2].score} pont`; }
  finalCard.classList.remove('hidden');
});

function renderLeaderboard(lb) {
  const html = lb.map((r,i)=>`<div>#${i+1} ${r.name} — ${r.score} pont</div>`).join('');
  gameStateEl.innerHTML = html;
}

function renderCounts(counts){
  if (!chart) return;
  chart.innerHTML = '';
  const labels = ['A','B','C','D'];
  const total = counts.reduce((a,b)=>a+b,0) || 1;
  counts.forEach((c,i)=>{
    const wrap = document.createElement('div');
    wrap.style.background = 'rgba(255,255,255,0.06)';
    wrap.style.border = '1px solid rgba(255,255,255,0.12)';
    wrap.style.borderRadius = '10px';
    wrap.style.padding = '8px';
    const bar = document.createElement('div');
    bar.style.height = '16px';
    bar.style.width = `${Math.round((c/total)*100)}%`;
    bar.style.background = 'linear-gradient(90deg,#22d3ee,#60a5fa,#7c3aed)';
    bar.style.borderRadius = '8px';
    const cap = document.createElement('div');
    cap.style.fontSize = '12px';
    cap.style.opacity = '0.8';
    cap.textContent = `${labels[i]}: ${c}`;
    wrap.appendChild(bar);
    wrap.appendChild(cap);
    chart.appendChild(wrap);
  });
}

// Controls
btnStart.onclick = () => socket.emit('host:start');
btnNext.onclick = () => socket.emit('host:next');
btnResetPin.onclick = () => socket.emit('host:reset-pin');
btnLoadSample.onclick = () => socket.emit('host:load-sample');
btnPause.onclick = () => socket.emit('host:pause');
btnResume.onclick = () => socket.emit('host:resume');
btnApplySettings.onclick = () => {
  socket.emit('host:set-settings', {
    teamMode: !!setTeam.checked,
    shuffleChoices: !!setShuffle.checked,
    baseDuration: Math.max(5, Math.min(120, Number(setDuration.value)||30))
  });
};

btnUpload.onclick = async () => {
  const f = fileQuestions.files[0];
  if (!f) return;
  const text = await f.text();
  try {
    const arr = JSON.parse(text);
    await fetch('/api/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(arr) });
  } catch (e) {
    alert('Érvénytelen JSON');
  }
};

// Reflect settings updates into controls
socket.on('settings:update', (s) => {
  if (typeof s.teamMode === 'boolean') setTeam.checked = s.teamMode;
  if (typeof s.shuffleChoices === 'boolean') setShuffle.checked = s.shuffleChoices;
  if (typeof s.baseDuration === 'number') setDuration.value = s.baseDuration;
});
