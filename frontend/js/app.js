/* ── APP STATE ────────────────────────────────────────────────
   Central mutable state object.
   ─────────────────────────────────────────────────────────── */

let SELECTED_SKILL = null;
let DOMAINS_DB = [];

/* ── NAVIGATION ──────────────────────────────────────────── */
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  window.scrollTo(0, 0);
}

function goHome() {
  skillCameraManager.destroy();
  sessionManager.isSessionActive = false;
  heuristicScorer.reset();
  SELECTED_SKILL = null;
  showPage('home');
}

/* ── بناء DOMAINS_DB من SKILL_CATALOG تلقائياً ──────────── */
function buildDomainsDB() {
  const catalog = CRITERIA_DB.getCatalog();
  const domainMeta = CRITERIA_DB.getDomainMeta();

  // اجمع المهارات تحت كل دومين
  const domainsMap = {};
  catalog.forEach(skill => {
    if (!domainsMap[skill.domain]) {
      const meta = domainMeta[skill.domain] || {
        name: skill.domain,
        emoji: "📋",
        tag: "Skills"
      };
      domainsMap[skill.domain] = {
        id: skill.domain,
        name: meta.name,
        emoji: meta.emoji,
        tag: meta.tag,
        skills: []
      };
    }
    domainsMap[skill.domain].skills.push(skill);
  });

  DOMAINS_DB = Object.values(domainsMap);
  console.log(`✓ تم بناء ${DOMAINS_DB.length} دومين من الكتالوج`);
}

/* ── HOME — بناء شبكة الدومينات ─────────────────────────── */
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function buildSkillGrid() {

  document.getElementById('skillGrid').innerHTML = DOMAINS_DB.map(domain => `
    <div class="skill-card" onclick="openDomain('${domain.id}')">
      <div class="skill-card-icon">${domain.emoji}</div>
      <div>
       <div class="skill-card-name">${escapeHTML(domain.name)}</div>
       <div class="skill-card-tag">${escapeHTML(domain.tag)}</div>
      </div>
    </div>
  `).join('');
}

/* ── DOMAIN PAGE — عرض مهارات الدومين ───────────────────── */
function openDomain(domainId) {
  const domain = DOMAINS_DB.find(d => d.id === domainId);
  if (!domain) return;

  document.getElementById('domainHeading').textContent = domain.name + ' Skills';

  document.getElementById('domainSkillsGrid').innerHTML = domain.skills.map(skill => `
    <div class="skill-card" onclick="selectDomainSkill('${skill.id}', this)">
      <div class="skill-card-icon">${skill.emoji}</div>
      <div>
       <div class="skill-card-name">${escapeHTML(skill.name)}</div>
<div class="skill-card-tag">${escapeHTML(skill.tag)}</div>
      </div>
    </div>
  `).join('');

  SELECTED_SKILL = null;
  document.getElementById('domainStartBtn').classList.remove('ready');
  showPage('domain');
}

/* ── اختيار مهارة ────────────────────────────────────────── */
function selectDomainSkill(skillId, el) {
  SELECTED_SKILL = skillId;

  document.querySelectorAll('#domainSkillsGrid .skill-card')
    .forEach(card => card.classList.remove('selected'));
  el.classList.add('selected');

  document.getElementById('domainStartBtn').classList.add('ready');
}

/* ── بدء الجلسة ──────────────────────────────────────────── */
async function startPractice() {
  if (!SELECTED_SKILL) return;

  showPage('practice');
  document.getElementById('session-status').textContent = 'Loading...';
  showCamState('stateIdle');

  await sessionManager.startSession(SELECTED_SKILL);
}

/* ── إيقاف الجلسة ────────────────────────────────────────── */
function stopSession() {
  sessionManager.endSession();
}

/* ── تفعيل الكاميرا ──────────────────────────────────────── */
async function requestCamera() {
  showCamState('stateRequesting');
  document.getElementById('session-status').textContent = 'Requesting Camera...';

  try {
    await skillCameraManager.initializePipeline('videoEl', 'poseCanvas');
    hideCamStates();
    document.getElementById('liveOverlay').style.display = 'block';
    document.getElementById('rhythmSection').style.display = 'block';
    document.getElementById('session-status').textContent = 'Session Active';
    sessionManager.isSessionActive = true;

  } catch (err) {
    showCamState('stateDenied');
    document.getElementById('session-status').textContent = 'Camera Error';
  }
}

/* ── مساعدات الكاميرا ────────────────────────────────────── */
function showCamState(id) {
  ['stateIdle', 'stateRequesting', 'stateDenied'].forEach(s => {
    document.getElementById(s).style.display = (s === id) ? 'flex' : 'none';
  });
}

function hideCamStates() {
  ['stateIdle', 'stateRequesting', 'stateDenied'].forEach(s => {
    document.getElementById(s).style.display = 'none';
  });
}

/* ── صفحة النتائج ────────────────────────────────────────── */
function buildResults(skillData, finalScore, feedbackLog) {
  showPage('results');

  const col = finalScore >= 80 ? 'var(--good)'
    : finalScore >= 60 ? 'var(--warn)'
      : 'var(--bad)';

  document.getElementById('resultEyebrow').textContent =
    `Session Report — ${skillData?.name || ''}`;

  const grades = [
    [90, 'Excellent', 'Outstanding technique. Ready for real-world application.'],
    [80, 'Good', 'Strong performance with minor areas to improve.'],
    [70, 'Proficient', 'Solid technique. Focus on the flagged areas.'],
    [60, 'Developing', 'Making progress — continue practising fundamentals.'],
    [0, 'Needs Work', 'Review clinical guidelines and practise again.']
  ];
  const [, grade, desc] = grades.find(([min]) => finalScore >= min);

  document.getElementById('result-title').textContent = grade + ' Performance';
  document.getElementById('score-grade').textContent = grade;
  document.getElementById('score-grade').style.color = col;
  document.getElementById('score-grade-desc').textContent = desc;

  // دائرة النتيجة
  const arc = document.getElementById('score-arc');
  const numEl = document.getElementById('final-score-num');
  numEl.style.color = col;

  setTimeout(() => {
    arc.style.strokeDashoffset = 439.8 - (finalScore / 100) * 439.8;
    arc.style.stroke = col;
  }, 300);

  let n = 0;
  if (window._scoreInterval) clearInterval(window._scoreInterval);
  const inc = setInterval(() => {
    window._scoreInterval = inc;
    n = Math.min(finalScore, n + 2);
    numEl.textContent = n;
    if (n >= finalScore) {
  clearInterval(inc);
  window._scoreInterval = null;
}
  }, 28);

  // المصدر
  if (skillData?.source) {
    document.getElementById('resultSourceRef').style.display = 'flex';
    document.getElementById('resultSourceLink').href = skillData.source.url;
    document.getElementById('resultSourceLink').textContent = skillData.source.label + ' ↗';
  }

  // نصائح التحسين
  const tips = skillData?.improvement_tips || [];
  document.getElementById('tips-list').innerHTML = tips
    .map((t, i) => `
      <div class="tip-item">
        <span class="tip-num">0${i + 1}</span>
<span>${escapeHTML(t)}</span>      </div>`)
    .join('');

  // Breakdown
  const uniqueFeedback = [...new Set(feedbackLog)].slice(0, 6);
  document.getElementById('breakdown-grid').innerHTML = uniqueFeedback.length
    ? uniqueFeedback.map(fb => `
        <div class="breakdown-card">
          <div class="bc-feedback">${escapeHTML(fb)}</div>
        </div>`).join('')
    : `<div style="color:var(--text-dim);font-family:var(--fm);padding:16px;">
         No issues detected during session.
       </div>`;
}

/* ── إعادة المحاولة ──────────────────────────────────────── */
function retrySession() {
  skillCameraManager.destroy();
  sessionManager.isSessionActive = false;
  sessionManager.currentScore = 100.0;
  sessionManager.feedbackLog = [];
  sessionManager.frameCounter = 0;
  heuristicScorer.reset();

  const el = (id) => document.getElementById(id);
  if (el('videoEl')) el('videoEl').style.display = 'none';
  if (el('poseCanvas')) el('poseCanvas').style.display = 'none';
  if (el('liveOverlay')) el('liveOverlay').style.display = 'none';
  if (el('rhythmSection')) el('rhythmSection').style.display = 'none';
  if (el('pmVal')) { el('pmVal').textContent = '—'; el('pmVal').className = 'color-neutral'; }
  if (el('pmStatus')) el('pmStatus').textContent = 'Begin to measure';
  if (el('pmBar')) el('pmBar').style.width = '0%';
  if (el('feedbackList')) el('feedbackList').innerHTML = `
    <div class="fb-item fb-warn">
      <span class="fb-icon">⚡</span>
      <span>Enable camera to begin.</span>
    </div>`;

  showPage('practice');
  showCamState('stateIdle');
  document.getElementById('session-status').textContent = 'Ready';
}

/* ── الإشعارات ───────────────────────────────────────────── */
let notifTimer = null;
function notify(msg) {
  const el = document.getElementById('notif');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ── INIT ────────────────────────────────────────────────── */
async function init() {
  await CRITERIA_DB.init();
  buildDomainsDB();
  buildSkillGrid();

  skillCameraManager.onFrame = (poseLandmarks, handLandmarks) => {
    sessionManager.processFrame(poseLandmarks, handLandmarks);
  };

  sessionManager.onSessionEnd = (skillData, score, log) => {
    buildResults(skillData, score, log);
  };

  skillCameraManager.getSessionState = () => ({
    ghostVisible: sessionManager._ghostVisible,
    skillId: sessionManager.currentSkillData?.id
});

  showPage('home');
  console.log('✓ App initialized with decoupled modules');
}

init();