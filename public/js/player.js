const socket = io();

const joinCard = document.getElementById('joinCard');
const gameCard = document.getElementById('gameCard');
const nameEl = document.getElementById('name');
const pinEl = document.getElementById('pin');
const btnJoin = document.getElementById('btnJoin');
const teamSelect = document.getElementById('team');
const joinError = document.getElementById('joinError');

const qText = document.getElementById('qText');
const choicesEl = document.getElementById('choices');
const timerEl = document.getElementById('timer');
const statusEl = document.getElementById('status');
const timebar = document.getElementById('timebarPlayer');
const finalCard = document.getElementById('finalCard');
const pf1Name = document.getElementById('pf1Name');
const pf1Score = document.getElementById('pf1Score');
const pf2Name = document.getElementById('pf2Name');
const pf2Score = document.getElementById('pf2Score');
const pf3Name = document.getElementById('pf3Name');
const pf3Score = document.getElementById('pf3Score');

let endsAt = null;
let timerInterval = null;
let answered = false;

function show(el){ el.classList.remove('hidden'); }
function hide(el){ el.classList.add('hidden'); }

btnJoin.onclick = () => {
  const name = nameEl.value.trim();
  const code = pinEl.value.trim();
  let team = teamSelect ? (teamSelect.value || undefined) : undefined;
  if (team) team = team.toLowerCase();
  socket.emit('player:join', { name, code, team });
};

socket.on('player:error', ({ message }) => {
  joinError.textContent = message;
});

socket.on('player:joined', ({ name }) => {
  hide(joinCard); show(gameCard);
  statusEl.textContent = `Csatlakozva: ${name}`;
});

socket.on('round:start', ({ question, endsAt: eEndsAt, index, total }) => {
  answered = false;
  endsAt = eEndsAt;
  qText.textContent = `${index+1}/${total} — ${question.text}`;
  choicesEl.innerHTML = '';
  question.choices.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'choice';
    div.textContent = `${String.fromCharCode(65+i)}. ${c}`;
    div.onclick = () => sendAnswer(i, div);
    choicesEl.appendChild(div);
  });
  startTimer();
  statusEl.textContent = '';
  if (pausedOverlay) pausedOverlay.style.display = 'none';
});

socket.on('round:end', ({ correctIndex, fastestCorrect }) => {
  stopTimer();
  // reveal
  Array.from(choicesEl.children).forEach((div, i) => {
    if (i === correctIndex) div.classList.add('correct');
    else if (div.classList.contains('selected')) div.classList.add('wrong');
  });
  if (fastestCorrect) {
    statusEl.textContent = `Leggyorsabb helyes: ${fastestCorrect.name} (${(fastestCorrect.timeMs/1000).toFixed(2)} mp)`;
  }
  answered = true;
});

// Pause/Resume overlays if present
const pausedOverlay = document.getElementById('pausedOverlay');
socket.on('round:paused', () => {
  stopTimer();
  if (pausedOverlay) pausedOverlay.style.display = 'flex';
});
socket.on('round:resumed', ({ endsAt: eEndsAt }) => {
  endsAt = eEndsAt;
  if (pausedOverlay) pausedOverlay.style.display = 'none';
  startTimer();
});

function sendAnswer(i, el) {
  if (answered) return;
  answered = true;
  el.classList.add('selected');
  socket.emit('player:answer', { choiceIndex: i });
}

function startTimer(){
  stopTimer();
  timerInterval = setInterval(()=>{
    if (!endsAt) return;
    const ms = Math.max(0, endsAt - Date.now());
    const sec = Math.ceil(ms/1000);
    timerEl.textContent = `Idő: ${sec} mp`;
    if (timebar) {
      const total = Math.max(1, sec);
      const pct = Math.max(0, Math.min(100, (ms / (ms + 1)) * 100));
      timebar.style.width = `${pct}%`;
    }
    if (ms <= 0) stopTimer();
  }, 250);
}
function stopTimer(){ if (timerInterval) clearInterval(timerInterval); timerInterval = null; }

// Show final top 3 when game finishes
socket.on('game:final', ({ leaderboard }) => {
  hide(gameCard);
  show(finalCard);
  const top = leaderboard.slice(0,3);
  if (top[0]) { pf1Name.textContent = top[0].name; pf1Score.textContent = `${top[0].score} pont`; }
  if (top[1]) { pf2Name.textContent = top[1].name; pf2Score.textContent = `${top[1].score} pont`; }
  if (top[2]) { pf3Name.textContent = top[2].name; pf3Score.textContent = `${top[2].score} pont`; }
});

// Auto-fill PIN from URL (QR) and hide the PIN input if present
(function initFromUrl(){
  const params = new URLSearchParams(window.location.search);
  const pin = params.get('pin');
  if (pin) {
    pinEl.value = pin;
    // Hide the PIN field to simplify the join flow via QR
    const pinWrapper = pinEl.closest('label') || pinEl;
    if (pinWrapper) pinWrapper.style.display = 'none';
  }
  nameEl.focus();
})();
