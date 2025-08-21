const state = {
  questions: []
};

const qText = document.getElementById('qText');
const c0 = document.getElementById('c0');
const c1 = document.getElementById('c1');
const c2 = document.getElementById('c2');
const c3 = document.getElementById('c3');
const ck0 = document.getElementById('ck0');
const ck1 = document.getElementById('ck1');
const ck2 = document.getElementById('ck2');
const ck3 = document.getElementById('ck3');
const btnAdd = document.getElementById('btnAdd');
const btnClear = document.getElementById('btnClear');
const btnExport = document.getElementById('btnExport');
const btnSend = document.getElementById('btnSend');
const btnSample = document.getElementById('btnSample');
const list = document.getElementById('list');
const count = document.getElementById('count');
const preview = document.getElementById('preview');

function resetForm() {
  qText.value = '';
  c0.value = '';
  c1.value = '';
  c2.value = '';
  c3.value = '';
  [ck0, ck1, ck2, ck3].forEach(ck => ck.checked = false);
}

function addQuestion() {
  const text = qText.value.trim();
  const choices = [c0.value.trim(), c1.value.trim(), c2.value.trim(), c3.value.trim()];
  const correctIndex = getCheckedIndex();

  if (!text || choices.some(c => !c) || correctIndex === -1) {
    alert('Kérlek tölts ki minden mezőt és jelöld be a helyes választ.');
    return;
  }

  const q = { text, choices, correctIndex };
  state.questions.push(q);
  renderList();
  resetForm();
}

function renderList() {
  count.textContent = String(state.questions.length);
  list.innerHTML = '';
  state.questions.forEach((q, idx) => {
    const div = document.createElement('div');
    div.className = 'q-item';
    const letters = ['A','B','C','D'];
    div.innerHTML = `
      <div><strong>${idx+1}. ${escapeHtml(q.text)}</strong></div>
      <ol style="margin:6px 0 8px 16px">
        ${q.choices.map((c,i)=>`<li>${letters[i]}. ${escapeHtml(c)} ${i===q.correctIndex?'<span class="tag">helyes</span>':''}</li>`).join('')}
      </ol>
      <div class="row">
        <button data-edit="${idx}" class="secondary">Szerkeszt</button>
        <button data-up="${idx}" class="secondary">Fel</button>
        <button data-down="${idx}" class="secondary">Le</button>
        <button data-del="${idx}" class="danger">Törlés</button>
      </div>
    `;
    list.appendChild(div);
  });
  updatePreview();
}

function updatePreview() {
  preview.textContent = JSON.stringify(state.questions, null, 2);
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state.questions, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'questions.json';
  a.click();
  URL.revokeObjectURL(url);
}

function sendToServer() {
  fetch('/api/questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.questions)
  }).then(res => {
    if (!res.ok) throw new Error('Hiba a feltöltésnél');
    alert('Kérdések feltöltve. Válts a Host oldalra és indítsd a játékot.');
  }).catch(()=>alert('Nem sikerült feltölteni. Ellenőrizd a szervert.'));
}

function editQuestion(idx) {
  const q = state.questions[idx];
  qText.value = q.text;
  c0.value = q.choices[0];
  c1.value = q.choices[1];
  c2.value = q.choices[2];
  c3.value = q.choices[3];
  [ck0, ck1, ck2, ck3].forEach((ck,i)=> ck.checked = (i === q.correctIndex));
  // replace on next add
  btnAdd.textContent = 'Mentés';
  btnAdd.onclick = () => {
    const text = qText.value.trim();
    const choices = [c0.value.trim(), c1.value.trim(), c2.value.trim(), c3.value.trim()];
    const correctIndex = getCheckedIndex();
    if (!text || choices.some(c => !c) || correctIndex === -1) {
      alert('Kérlek tölts ki minden mezőt és jelöld be a helyes választ.');
      return;
    }
    state.questions[idx] = { text, choices, correctIndex };
    renderList();
    resetForm();
    btnAdd.textContent = 'Hozzáadás';
    btnAdd.onclick = addQuestion;
  };
}

function moveUp(idx) {
  if (idx <= 0) return;
  const tmp = state.questions[idx-1];
  state.questions[idx-1] = state.questions[idx];
  state.questions[idx] = tmp;
  renderList();
}

function moveDown(idx) {
  if (idx >= state.questions.length-1) return;
  const tmp = state.questions[idx+1];
  state.questions[idx+1] = state.questions[idx];
  state.questions[idx] = tmp;
  renderList();
}

function removeQuestion(idx) {
  state.questions.splice(idx, 1);
  renderList();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[s]));
}

list.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.edit) editQuestion(Number(t.dataset.edit));
  if (t.dataset.up) moveUp(Number(t.dataset.up));
  if (t.dataset.down) moveDown(Number(t.dataset.down));
  if (t.dataset.del) removeQuestion(Number(t.dataset.del));
});

btnAdd.onclick = addQuestion;
btnClear.onclick = resetForm;
btnExport.onclick = exportJson;
btnSend.onclick = sendToServer;
btnSample.onclick = async () => {
  try {
    const res = await fetch('/api/sample-questions');
    if (!res.ok) throw new Error();
    const arr = await res.json();
    state.questions = arr.map(q => ({ text: q.text, choices: q.choices, correctIndex: q.correctIndex }));
    renderList();
  } catch {
    alert('Nem sikerült betölteni a mintát.');
  }
};

renderList();

// Helpers
function getCheckedIndex() {
  const boxes = [ck0, ck1, ck2, ck3];
  let idx = -1;
  boxes.forEach((ck, i) => { if (ck.checked) idx = i; });
  return idx;
}

// Enforce single selection behavior for checkboxes
[ck0, ck1, ck2, ck3].forEach((ck, i, arr) => {
  ck.addEventListener('change', () => {
    if (ck.checked) arr.forEach((o, j) => { if (j !== i) o.checked = false; });
  });
});
