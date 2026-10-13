/**
 * app_v2.js — SignBridge App Controller (two hands + any sign language)
 * Keep asl.js loaded (needed for the built-in ASL mode).
 */

// ── Settings ───────────────────────────────────────────────────────────────
const HOLD_MS        = 1500;   // how long to hold a sign before it locks
const MIN_CONF       = 0.68;   // minimum confidence to start the hold timer
const ASL_NAME       = 'ASL (built-in)';
const STORAGE_KEY    = 'signbridge_profiles_v1';
const SAMPLES_PER_REC = 30;    // frames captured per "Record" click
const K_NEIGHBOURS   = 5;      // kNN: how many nearest samples vote
const MAX_DIST       = 3.0;    // kNN: further than this = "unknown sign" (tune me)

// ── State ──────────────────────────────────────────────────────────────────
let currentWord   = '';
let transcriptStr = '';
let lastLetter    = '';
let holdStart     = null;
let letterLocked  = false;
let handsInstance = null;
let animFrame     = null;

let profiles   = loadProfiles();  
let activeLang = ASL_NAME;
let recording  = null;       
// ── DOM refs ───────────────────────────────────────────────────────────────
const video        = document.getElementById('video');
const canvas       = document.getElementById('landmarkCanvas');
const ctx          = canvas.getContext('2d');
const statusDot    = document.getElementById('statusDot');
const statusText   = document.getElementById('statusText');
const bigLetter    = document.getElementById('bigLetter');
const confFill     = document.getElementById('confFill');
const confPct      = document.getElementById('confPct');
const holdFill     = document.getElementById('holdFill');
const wordText     = document.getElementById('wordText');
const transcriptEl = document.getElementById('transcript');
const noCam        = document.getElementById('noCam');
const camBadge     = document.getElementById('camBadge');
const startBtn     = document.getElementById('startBtn');
const spaceBtn     = document.getElementById('spaceBtn');
const backBtn      = document.getElementById('backBtn');
const clearBtn     = document.getElementById('clearBtn');
const speakBtn     = document.getElementById('speakBtn');
const speakWordBtn = document.getElementById('speakWordBtn');
const refGrid      = document.getElementById('refGrid');

// ── Profiles (saved languages) ─────────────────────────────────────────────
function loadProfiles() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch (_) { return {}; }
}
function saveProfiles() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles)); }
  catch (e) { alert('Could not save: browser storage is full or blocked.'); }
}

// ── Reference chip grid ────────────────────────────────────────────────────
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const HINTS = {
  A:'fist+thumb', B:'all up', C:'curved', D:'index+circle',
  E:'all curl', F:'ok+up', G:'side point', H:'2 horiz',
  I:'pinky', J:'pinky+arc', K:'2+thumb', L:'L-shape',
  M:'3 over', N:'2 over', O:'O-shape', P:'K-down',
  Q:'G-down', R:'cross', S:'fist-thumb', T:'thumb-in',
  U:'2 together', V:'2 spread', W:'3 up', X:'hook',
  Y:'Y-shape', Z:'draw Z'
};

// Rebuild the chips for whichever language is active.
function buildRefGrid() {
  refGrid.innerHTML = '';
  let items;
  if (activeLang === ASL_NAME) {
    items = LETTERS.map(l => [l, HINTS[l] || '']);
  } else {
    const samples = (profiles[activeLang] || { samples: {} }).samples;
    items = Object.keys(samples).map(l => [l, samples[l].length + ' samples']);
  }
  items.forEach(([label, hint]) => {
    const chip = document.createElement('div');
    chip.className = 'ref-chip';
    chip.dataset.label = label;
    chip.innerHTML = `<span class="letter-key"></span><span class="finger-hint"></span>`;
    chip.querySelector('.letter-key').textContent = label;   // textContent = safe
    chip.querySelector('.finger-hint').textContent = hint;
    refGrid.appendChild(chip);
  });
}

// ── Status helpers ─────────────────────────────────────────────────────────
function setStatus(state, text) {
  statusDot.className = 'dot ' + state;
  statusText.textContent = text;
}

function setActiveRef(label) {
  document.querySelectorAll('.ref-chip').forEach(c => {
    c.classList.toggle('active', !!label && c.dataset.label === label);
  });
}

// ── Word / transcript management ──────────────────────────────────────────
function updateWordDisplay() {
  wordText.textContent = currentWord;
}

function addLetter(letter) {
  currentWord += letter;
  updateWordDisplay();
  enableButtons();
}

function addSpace() {
  if (!currentWord) return;
  transcriptStr += (transcriptStr ? ' ' : '') + currentWord;
  transcriptEl.textContent = transcriptStr;
  currentWord = '';
  updateWordDisplay();
  speakBtn.disabled = false;
}

// A sign can be one letter ("A") or a whole word/phrase ("HELLO").
function addToken(token) {
  if (token.length > 1) {          // whole word: finish any spelling, then add it
    addSpace();
    currentWord = token;
    updateWordDisplay();
    enableButtons();
    addSpace();
  } else {
    addLetter(token);
  }
}

function backspace() {
  currentWord = currentWord.slice(0, -1);
  updateWordDisplay();
}

function clearAll() {
  currentWord = '';
  transcriptStr = '';
  transcriptEl.textContent = 'Your words will appear here...';
  updateWordDisplay();
  resetHold();
  bigLetter.textContent = '—';
  confFill.style.width = '0%';
  confPct.textContent = '0%';
  setActiveRef(null);
}

function enableButtons() {
  spaceBtn.disabled = false;
  backBtn.disabled = false;
  clearBtn.disabled = false;
  speakWordBtn.disabled = false;
}

function resetHold() {
  lastLetter = '';
  holdStart = null;
  letterLocked = false;
  holdFill.style.width = '0%';
}

// ── Speech ────────────────────────────────────────────────────────────────
function speakTranscript() {
  speak(transcriptStr + (currentWord ? ' ' + currentWord : ''));
}

function speakWord() {
  speak(currentWord);
}

function speak(text) {
  if (!text || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  const prof = profiles[activeLang];
  utt.lang  = (prof && prof.speechLang) || 'en-US';   // pick the voice language
  utt.rate  = 0.9;
  utt.pitch = 1;
  speechSynthesis.speak(utt);
}

// ── Camera ────────────────────────────────────────────────────────────────
async function startCamera() {
  startBtn.disabled = true;
  startBtn.textContent = 'Starting...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
    });
    video.srcObject = stream;

    video.onloadedmetadata = () => {
      video.play();
      noCam.classList.add('hidden');
      camBadge.classList.add('visible');
      startBtn.textContent = '● Recording';
      setStatus('active', 'Initialising...');
      initMediaPipe();
    };
  } catch (err) {
    startBtn.disabled = false;
    startBtn.textContent = 'Start Camera';
    setStatus('off', 'Camera denied');
    console.error('Camera error:', err);
    alert('Camera permission required.\n\nPlease allow camera access in your browser and try again.');
  }
}

// ── MediaPipe Hands ───────────────────────────────────────────────────────
function initMediaPipe() {
  if (typeof Hands === 'undefined') {
    setStatus('detecting', 'Loading MediaPipe...');
    setTimeout(initMediaPipe, 600);
    return;
  }

  handsInstance = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  handsInstance.setOptions({
    maxNumHands: 2,                 // <-- both hands
    modelComplexity: 1,
    minDetectionConfidence: 0.70,
    minTrackingConfidence: 0.65
  });

  handsInstance.onResults(onHandResults);

  handsInstance.initialize().then(() => {
    setStatus('active', 'Ready — show your hand(s)');
    startProcessing();
  }).catch(err => {
    console.error('MediaPipe init error:', err);
    setStatus('off', 'MediaPipe failed to load');
  });
}

function startProcessing() {
  async function loop() {
    if (video.readyState >= 2) {
      try { await handsInstance.send({ image: video }); } catch (_) {}
    }
    animFrame = requestAnimationFrame(loop);
  }
  loop();
}

// ── Feature extraction for custom languages ───────────────────────────────
// Goal: turn raw landmarks into numbers that do NOT change when you move your
// hand closer/further from the camera or to another spot in the picture.

function dist2D(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// One hand -> 63 numbers: every point relative to the wrist, divided by hand size.
function handVector(lm) {
  const base  = lm[0];
  const scale = dist2D(lm[0], lm[9]) || 1e-6;      // wrist -> middle knuckle
  const out = [];
  for (const p of lm) {
    out.push((p.x - base.x) / scale, (p.y - base.y) / scale, (p.z - base.z) / scale);
  }
  return out;
}

// Whole frame -> 128 numbers: hand 1 (63) + hand 2 (63) + where hand 2 is
// relative to hand 1 (2). The left-most hand on screen is always "hand 1", so
// the order is stable. A missing hand is filled with zeros.
function frameVector(hands) {
  const sorted = [...hands].sort((a, b) => a[0].x - b[0].x);
  const h1 = sorted[0];
  const h2 = sorted[1];
  const v1 = handVector(h1);
  const v2 = h2 ? handVector(h2) : new Array(63).fill(0);
  let rel = [0, 0];
  if (h2) {
    const s = dist2D(h1[0], h1[9]) || 1e-6;
    rel = [(h2[0].x - h1[0].x) / s, (h2[0].y - h1[0].y) / s];
  }
  return [...v1, ...v2, ...rel];
}

// ── kNN classifier (the "learning" part) ──────────────────────────────────
function vecDist(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

// Compare the current frame with every saved sample, let the K closest vote.
function classifyCustom(vec) {
  const prof = profiles[activeLang];
  if (!prof) return { letter: null, confidence: 0 };

  const scored = [];
  for (const label of Object.keys(prof.samples)) {
    for (const s of prof.samples[label]) scored.push([vecDist(vec, s), label]);
  }
  if (scored.length === 0) return { letter: null, confidence: 0 };

  scored.sort((a, b) => a[0] - b[0]);
  const nearest = scored[0][0];
  if (nearest > MAX_DIST) return { letter: null, confidence: 0 };   // too unlike anything taught

  const votes = {};
  let total = 0;
  for (const [d, label] of scored.slice(0, K_NEIGHBOURS)) {
    const w = 1 / (d + 0.01);                // closer samples count more
    votes[label] = (votes[label] || 0) + w;
    total += w;
  }
  const best = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
  const share = votes[best] / total;                       // how strongly the vote agrees
  const closeness = 1 - 0.5 * (nearest / MAX_DIST);       // nearer = more confident
  return { letter: best, confidence: share * closeness };
}

// Built-in ASL: run your existing classifyASL on each hand, keep the best.
function classifyBuiltinASL(hands) {
  let best = { letter: null, confidence: 0 };
  for (const lm of hands) {
    const r = classifyASL(lm);
    if (r && r.letter && r.confidence > best.confidence) best = r;
  }
  return best;
}

// ── Result handler ─────────────────────────────────────────────────────────
function onHandResults(results) {
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const hands = results.multiHandLandmarks || [];

  if (hands.length === 0) {
    setStatus('active', 'No hand detected');
    bigLetter.textContent = '—';
    confFill.style.width = '0%';
    confPct.textContent = '0%';
    resetHold();
    setActiveRef(null);
    return;
  }

  // Draw every hand (green for the first, blue for the second)
  hands.forEach((lm, i) => drawSkeleton(lm, i === 0 ? '#1D9E75' : '#378ADD',
                                              i === 0 ? '#5DCAA5' : '#85B7EB'));

  const vec = frameVector(hands);

  // Teaching mode: store this frame as a sample, don't type anything.
  if (recording) {
    recording.profile.samples[recording.label].push(vec.map(n => +n.toFixed(4)));
    recording.remaining--;
    updateTeachInfo(`Recording "${recording.label}"... ${SAMPLES_PER_REC - recording.remaining}/${SAMPLES_PER_REC}`);
    if (recording.remaining <= 0) finishRecording();
    return;
  }

  // Recognise
  const { letter, confidence } =
    activeLang === ASL_NAME ? classifyBuiltinASL(hands) : classifyCustom(vec);
  const pct = Math.round(confidence * 100);

  confFill.style.width = pct + '%';
  confPct.textContent  = pct + '%';

  const handsTxt = hands.length === 2 ? '2 hands' : '1 hand';

  if (!letter || confidence < MIN_CONF) {
    setStatus('detecting', `${handsTxt} seen — signing...`);
    bigLetter.textContent = '?';
    resetHold();
    setActiveRef(null);
    return;
  }

  if (bigLetter.textContent !== letter) bigLetter.textContent = letter;
  setActiveRef(letter);
  setStatus('detecting', `Detected: ${letter} (${pct}%, ${handsTxt})`);

  // Hold timer
  if (letter !== lastLetter) {
    lastLetter   = letter;
    holdStart    = Date.now();
    letterLocked = false;
    holdFill.style.width = '0%';
  } else if (!letterLocked) {
    const elapsed  = Date.now() - holdStart;
    holdFill.style.width = Math.min((elapsed / HOLD_MS) * 100, 100) + '%';

    if (elapsed >= HOLD_MS) {
      letterLocked = true;
      holdFill.style.width = '100%';

      bigLetter.classList.add('pop');
      setTimeout(() => bigLetter.classList.remove('pop'), 250);

      addToken(letter);

      setTimeout(() => {
        if (lastLetter === letter) resetHold();
      }, 800);
    }
  }
}

// ── Skeleton drawing ───────────────────────────────────────────────────────
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17]
];

function drawSkeleton(lm, lineColour, dotColour) {
  const w = canvas.width;
  const h = canvas.height;

  ctx.strokeStyle = lineColour;
  ctx.lineWidth   = 2;
  CONNECTIONS.forEach(([a, b]) => {
    ctx.beginPath();
    ctx.moveTo(lm[a].x * w, lm[a].y * h);
    ctx.lineTo(lm[b].x * w, lm[b].y * h);
    ctx.stroke();
  });

  lm.forEach((pt, i) => {
    ctx.beginPath();
    ctx.arc(pt.x * w, pt.y * h, i === 0 ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#EF9F27' : dotColour;
    ctx.fill();
  });
}

// ── Language + teaching panel  ─────────
let langSelect, teachInput, recordBtn, teachInfo;

function buildLanguagePanel() {
  const panel = document.createElement('div');
  panel.style.cssText =
    'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0;font:14px system-ui,sans-serif';

  panel.innerHTML = `
    <label>Language:
      <select id="langSelect"></select>
    </label>
    <button id="newLangBtn" type="button">+ New language</button>
    <button id="delLangBtn" type="button">Delete language</button>
    <span style="flex-basis:100%"></span>
    <input id="teachInput" type="text" maxlength="24"
           placeholder="Sign name (A, HELLO...)" style="padding:4px 8px">
    <button id="recordBtn" type="button">● Teach this sign</button>
    <button id="delSignBtn" type="button">Remove sign</button>
    <button id="exportBtn" type="button">Export</button>
    <button id="importBtn" type="button">Import</button>
    <input id="importFile" type="file" accept="application/json" hidden>
    <span id="teachInfo" style="flex-basis:100%;opacity:.75"></span>`;

  refGrid.parentNode.insertBefore(panel, refGrid);

  langSelect = panel.querySelector('#langSelect');
  teachInput = panel.querySelector('#teachInput');
  recordBtn  = panel.querySelector('#recordBtn');
  teachInfo  = panel.querySelector('#teachInfo');

  langSelect.onchange = () => { switchLanguage(langSelect.value); };
  panel.querySelector('#newLangBtn').onclick = newLanguage;
  panel.querySelector('#delLangBtn').onclick = deleteLanguage;
  recordBtn.onclick = startRecording;
  panel.querySelector('#delSignBtn').onclick = deleteSign;
  panel.querySelector('#exportBtn').onclick = exportProfiles;
  panel.querySelector('#importBtn').onclick = () => panel.querySelector('#importFile').click();
  panel.querySelector('#importFile').onchange = importProfiles;

  refreshLanguageList();
}

function refreshLanguageList() {
  langSelect.innerHTML = '';
  [ASL_NAME, ...Object.keys(profiles)].forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    langSelect.appendChild(opt);
  });
  langSelect.value = activeLang;
  const custom = activeLang !== ASL_NAME;
  recordBtn.disabled = !custom;
  teachInput.disabled = !custom;
  updateTeachInfo(custom
    ? 'Type a sign name, make the sign (one or both hands), click "Teach". Teach each sign 2-3 times for best accuracy.'
    : 'Built-in ASL fingerspelling is active. Create a new language to teach your own signs.');
}

function updateTeachInfo(text) { if (teachInfo) teachInfo.textContent = text; }

function switchLanguage(name) {
  activeLang = name;
  resetHold();
  refreshLanguageList();
  buildRefGrid();
}

function newLanguage() {
  const name = (prompt('Name of the sign language (e.g. ISL, BSL, My signs):') || '').trim();
  if (!name) return;
  if (name === ASL_NAME || profiles[name]) { alert('That name already exists.'); return; }
  const lang = (prompt('Voice language code for speech (e.g. en-US, en-IN, hi-IN, en-GB):', 'en-US') || 'en-US').trim();
  profiles[name] = { speechLang: lang, samples: {} };
  saveProfiles();
  switchLanguage(name);
}

function deleteLanguage() {
  if (activeLang === ASL_NAME) { alert('The built-in ASL mode cannot be deleted.'); return; }
  if (!confirm(`Delete "${activeLang}" and all its signs?`)) return;
  delete profiles[activeLang];
  saveProfiles();
  switchLanguage(ASL_NAME);
}

function startRecording() {
  const label = teachInput.value.trim();
  const prof  = profiles[activeLang];
  if (!prof) return;
  if (!label) { updateTeachInfo('Type the sign name first.'); return; }
  if (!handsInstance) { updateTeachInfo('Start the camera first.'); return; }

  recordBtn.disabled = true;
  let n = 3;
  const tick = () => {
    if (n > 0) {
      updateTeachInfo(`Get ready: "${label}" in ${n}...`);
      n--;
      setTimeout(tick, 1000);
    } else {
      if (!prof.samples[label]) prof.samples[label] = [];
      recording = { label, profile: prof, remaining: SAMPLES_PER_REC };
    }
  };
  tick();
}

function finishRecording() {
  const label = recording.label;
  recording = null;
  saveProfiles();
  buildRefGrid();
  recordBtn.disabled = false;
  updateTeachInfo(`Saved "${label}" (${profiles[activeLang].samples[label].length} samples). Teach it again from a slightly different angle, or add another sign.`);
}

function deleteSign() {
  const label = teachInput.value.trim();
  const prof  = profiles[activeLang];
  if (!prof || !prof.samples[label]) { updateTeachInfo('No such sign. Type its exact name.'); return; }
  delete prof.samples[label];
  saveProfiles();
  buildRefGrid();
  updateTeachInfo(`Removed "${label}".`);
}

function exportProfiles() {
  const blob = new Blob([JSON.stringify(profiles)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'signbridge-languages.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importProfiles(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      Object.keys(data).forEach(name => {
        if (data[name] && data[name].samples) profiles[name] = data[name];
      });
      saveProfiles();
      refreshLanguageList();
      updateTeachInfo('Import complete.');
    } catch (_) {
      alert('That file is not a valid SignBridge export.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ── Init ───────────────────────────────────────────────────────────────────
buildLanguagePanel();
buildRefGrid();
updateWordDisplay();
setStatus('off', 'Camera off');
