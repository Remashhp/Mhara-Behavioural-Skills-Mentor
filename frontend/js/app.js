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

async function goHome() {
  await skillCameraManager.destroy();
  sessionManager.reset();
  SELECTED_SKILL = null;
  showPage('home');
}

/* ── Automatically Build DOMAINS_DB from SKILL_CATALOG ──────────── */
function buildDomainsDB() {
  const catalog = CRITERIA_DB.getCatalog();
  const domainMeta = CRITERIA_DB.getDomainMeta();

  // Group skills under each domain
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

/* ── HOME — Build the Domain Grid ─────────────────────────── */

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

/* ──  Display Domain Skills ───────────────────── */
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

/* ── select skill────────────────────────────────────────── */
function selectDomainSkill(skillId, el) {
  SELECTED_SKILL = skillId;

  document.querySelectorAll('#domainSkillsGrid .skill-card')
    .forEach(card => card.classList.remove('selected'));
  el.classList.add('selected');

  document.getElementById('domainStartBtn').classList.add('ready');
}

/* ── Start Session ────────────────────────────────────────── */

/*
async function startPractice() {
  if (!SELECTED_SKILL) return;

  showPage('practice');
  document.getElementById('session-status').textContent = 'Loading...';
  showCamState('stateIdle');

  await sessionManager.startSession(SELECTED_SKILL);
} */
  

async function startPractice() {
  if (!SELECTED_SKILL) return;
  document.getElementById('consentModal').style.display = 'block';
}

/* ── Stop Assessment Session ─────────────────────────────── */
function stopSession() {
  sessionManager.endSession();
}

/* ── Enable Camera ───────────────────────────────────────── */


/* Signals That Require the Hands Model — Must Match session.js and main.py */
const HAND_SIGNALS = new Set([
  'finger_spread', 'interdigital_coverage', 'palm_to_palm_contact',
  'wrist_rotation', 'thumb_coverage', 'fist_formation', 'thumb_position'
]);

async function requestCamera() {
  showCamState('stateRequesting');
  document.getElementById('session-status').textContent = 'Requesting Camera...';

  try {
    /* Load the Hands model only if the selected skill requires it. */
    const needsHands = CRITERIA_DB.requiresHands(
      sessionManager.currentSkillData?.dimensions
    );

    await skillCameraManager.initializePipeline('videoEl', 'poseCanvas', needsHands);
    hideCamStates();

    /* Show the canvas — it remained hidden, causing the gray screen issue. */
    document.getElementById('poseCanvas').style.display = 'block';

    document.getElementById('liveOverlay').style.display = 'block';
    document.getElementById('rhythmSection').style.display = 'block';
    document.getElementById('session-status').textContent = 'Session Active';
    sessionManager.beginAssessment();

  } catch (err) {
    console.error('Camera initialization failed:', err);

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      // User denied camera permission — show the unblock instructions
      showCamState('stateDenied');
      document.getElementById('session-status').textContent = 'Camera Blocked';

    } else if (err.name === 'NotFoundError' || err.name === 'NotReadableError') {
      // No camera found, or camera is in use by another app
      showCamState('stateIdle');
      document.getElementById('session-status').textContent = 'Camera Unavailable';
      notify('No usable camera found — close other apps using the camera and retry.');

    } else {
      // Network / model-loading / engine failure — NOT a permission issue
      showCamState('stateIdle');
      document.getElementById('session-status').textContent = 'Engine Load Error';
      notify('Failed to load tracking engine — check your connection and retry.');
    }
  }
}

/* ── Camera State Helpers ────────────────────────────────── */
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

/* ── Results Page ────────────────────────────────────────── */
function buildResults(skillData, finalScore, feedbackLog, savedScores) {
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

  // Score indicator

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

  // Reference source

  if (skillData?.source) {
    document.getElementById('resultSourceRef').style.display = 'flex';
    document.getElementById('resultSourceLink').href = skillData.source.url;
    document.getElementById('resultSourceLink').textContent = skillData.source.label + ' ↗';
  }

  // Improvement tips
// Breakdown — per dimension scores
  const dims = skillData?.dimensions || [];
  const dimScores = savedScores || sessionManager._dimensionScores;
  document.getElementById('breakdown-grid').innerHTML = dims.map(d => {
    const t = dimScores[d.id];
    const pct = (t && t.total > 0) ? Math.round((t.valid / t.total) * 100) : null;
    const col2 = pct === null ? 'var(--text-dim)'
      : pct >= 80 ? 'var(--good)'
      : pct >= 60 ? 'var(--warn)'
      : 'var(--bad)';
    return `
      <div class="breakdown-card">
        <div class="bc-feedback">${escapeHTML(d.name)}</div>
        <div style="font-size:24px;font-weight:700;color:${col2};margin-top:8px;">
          ${pct !== null ? pct + '%' : '—'}
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">
          ${pct === null ? 'Not measured'
            : pct >= 80 ? '✓ ' + escapeHTML(d.good_feedback)
            : '✗ ' + escapeHTML(d.bad_feedback)}
        </div>
      </div>`;
  }).join('') || `<div style="color:var(--text-dim);padding:16px;">No data.</div>`;

  // Dynamic improvement tips — based on what failed this session
  const failedDims = dims.filter(d => {
    const t = dimScores[d.id];
    return t && t.total > 0 && (t.valid / t.total) < 0.6;
  });

  const dynamicTips = failedDims.length > 0
    ? failedDims.map(d => d.warn_feedback || d.bad_feedback)
    : skillData?.improvement_tips || [];

  document.getElementById('tips-list').innerHTML = dynamicTips
    .map((t, i) => `
      <div class="tip-item">
        <span class="tip-num">0${i + 1}</span>
        <span>${escapeHTML(t)}</span>
      </div>`).join('');

        // Show survey after 2 seconds
  setTimeout(() => showSurvey(skillData?.id, finalScore), 2000);
}

/* ── Retry Assessment Session ────────────────────────────── */
async function retrySession() {
  await skillCameraManager.destroy();
  sessionManager.reset();

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

/* ── Notifications ───────────────────────────────────────── */

let notifTimer = null;
function notify(msg) {
  const el = document.getElementById('notif');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => el.classList.remove('show'), 3200);
}



/* ── Survey ──────────────────────────────────────────── */
let _surveySkillId = null;
let _surveyScore = null;

function showSurvey(skillId, score) {
  _surveySkillId = skillId;
  _surveyScore = score;

  const skillNames = {
    'cpr': 'مهارة الإنعاش القلبي (CPR)',
    'heimlich': 'مهارة التعامل مع الاختناق',
    'hand_hygiene': 'مهارة تعقيم اليدين',
    'safe_lifting': 'مهارة الرفع الآمن'
  };

  const label = document.getElementById('surveySkillLabel');
  if (label) label.textContent = `المهارة المُقيَّمة: ${skillNames[skillId] || skillId}`;

  document.getElementById('surveyModal').style.display = 'block';
}

function closeSurvey() {
  document.getElementById('surveyModal').style.display = 'none';
}

async function submitSurvey() {
  const data = {
    skill_id: _surveySkillId,
    final_score: _surveyScore,
    q1_usability: document.getElementById('sq1').value,
    q2_feedback_useful: document.getElementById('sq2').value,
    q3_accuracy: document.getElementById('sq3').value,
    q6_best_feature: document.getElementById('sq6').value,
    q7_improvements: document.getElementById('sq7').value,
    q9_name: document.getElementById('sq9').value,
    q10_specialty: document.getElementById('sq10').value,
    q11_email: document.getElementById('sq11').value,
    q12_phone: document.getElementById('sq12').value,
    q13_future_participation: document.getElementById('sq13').value,
  };

  try {
    await fetch(`${CONFIG.API_BASE}/survey`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (e) {
    console.warn('Survey submit failed:', e);
  }
  closeSurvey();
}



function acceptConsent() {
  document.getElementById('consentModal').style.display = 'none';
  showPage('practice');
  document.getElementById('session-status').textContent = 'Loading...';
  showCamState('stateIdle');
  sessionManager.startSession(SELECTED_SKILL);
}

function declineConsent() {
  document.getElementById('consentModal').style.display = 'none';
  SELECTED_SKILL = null;
  goHome();
}


/* ── SESSION UI RENDERING ─────────────────────────────────────
   All DOM updates for session events live HERE.
   session.js only announces events via callbacks.
   ─────────────────────────────────────────────────────────── */
function wireSessionUI() {
  const el = (id) => document.getElementById(id);
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // Skill loaded → fill labels + build live criteria rows
  sessionManager.onSkillLoaded = (skillData) => {
    const pm = skillData.primary_metric;
    if (el('skillBadgePractice')) el('skillBadgePractice').textContent = skillData.name;
    if (el('pmLabel')) el('pmLabel').textContent = pm?.label || 'Rate';
    if (el('pmTarget')) el('pmTarget').textContent = pm?.target_display || '—';
    if (el('pmUnit')) el('pmUnit').textContent = pm?.unit || '';

    const scoresEl = el('liveCriteriaScores');
    if (scoresEl) {
      scoresEl.innerHTML = skillData.dimensions.map(d => `
        <div class="score-row-mini">
          <span class="score-name-mini">${escapeHTML(d.name)}</span>
          <div class="score-bar-mini">
            <div class="score-bar-fill" id="sb-${d.id}" style="width:0%"></div>
          </div>
          <span class="score-pct-mini" id="sv-${d.id}">—</span>
        </div>
      `).join('');
    }
  };

  // Overall score → pmVal ONLY for non-CPR skills.
  // In CPR, pmVal belongs to BPM (fixes the pmVal conflict).
  sessionManager.onScoreUpdate = (score) => {
    if (sessionManager.currentSkillData?.id === 'cpr') return;

    const val = el('pmVal');
    if (val) {
      val.textContent = Math.round(score) + '%';
      val.className = score >= 80 ? 'color-good' : score >= 60 ? 'color-warn' : 'color-bad';
    }
    const bar = el('pmBar');
    if (bar) bar.style.width = Math.round(score) + '%';

    const status = el('pmStatus');
    if (status) {
      status.textContent = score >= 80 ? 'Excellent'
        : score >= 60 ? 'Good'
          : 'Needs improvement';
    }
  };

  // BPM (CPR only) → owns pmVal
  sessionManager.onBPMUpdate = (bpm, isValid) => {
    const val = el('pmVal');
    if (val) {
      val.textContent = bpm;
      val.className = isValid ? 'color-good' : 'color-warn';
    }
  };

  // Compression detected → counter + rhythm wave
  sessionManager.onCompression = (count, rhythmValid) => {
    if (el('compCount')) el('compCount').textContent = count;
    if (el('compSub')) el('compSub').textContent = `${count} compressions detected`;

    const wave = el('rhythmWave');
    if (wave) {
      const bar = document.createElement('div');
      bar.className = 'rhythm-bar';
      bar.style.height = rhythmValid ? '100%' : '40%';
      bar.style.background = rhythmValid ? 'var(--good)' : 'var(--warn)';
      wave.appendChild(bar);
      while (wave.children.length > 20) {
        wave.removeChild(wave.firstChild);
      }
    }
  };

  // Per-dimension result → mini bars + throttled feedback feed
  sessionManager.onDimensionFeedback = (dimId, message, isValid, showInFeed, ratio) => {
    const bar = el(`sb-${dimId}`);
    const val = el(`sv-${dimId}`);
    const color = isValid ? 'var(--good)' : 'var(--bad)';

    if (bar) {
      bar.style.width = (ratio ?? 0) + '%';
      bar.style.background = color;
    }
    if (val) {
      val.textContent = ratio !== null ? ratio + '%' : '—';
      val.style.color = color;
    }

    const feedbackList = el('feedbackList');
    if (feedbackList && showInFeed) {
      const cls = isValid ? 'fb-good' : 'fb-bad';
      const icon = isValid ? '✓' : '🔴';
      const item = document.createElement('div');
      item.className = `fb-item ${cls}`;
      item.innerHTML = `
        <span class="fb-icon">${icon}</span>
        <span>${escapeHTML(message)}</span>`;
      feedbackList.appendChild(item);

      while (feedbackList.children.length > 5) {
        feedbackList.removeChild(feedbackList.firstChild);
      }
    }
  };

  // Timer tick
  sessionManager.onTimerTick = (remaining, urgent) => {
    const timerEl = el('timerDisp');
    if (!timerEl) return;
    timerEl.textContent = fmt(remaining);
    timerEl.classList.toggle('urgent', urgent);
  };

  // Fatal session error → feedback panel
  sessionManager.onError = (message) => {
    const feedbackList = el('feedbackList');
    if (feedbackList) {
      feedbackList.innerHTML = `
        <div class="fb-item fb-bad">
          <span class="fb-icon">❌</span>
          <span>${escapeHTML(message)}</span>
        </div>`;
    }
  };

  // Non-fatal notices → toast
  sessionManager.onNotify = (msg) => notify(msg);
}

/* ── INIT ────────────────────────────────────────────────── */
async function init() {
  await CRITERIA_DB.init();
  buildDomainsDB();
  buildSkillGrid();
  wireSessionUI();
  skillCameraManager.onFrame = (poseLandmarks, handLandmarks) => {
    sessionManager.processFrame(poseLandmarks, handLandmarks);
  };

  sessionManager.onSessionEnd = async (skillData, score, log) => {
    const savedScores = { ...sessionManager._dimensionScores };
    await skillCameraManager.destroy();
    buildResults(skillData, score, log, savedScores);
  };

  skillCameraManager.getSessionState = () => ({
    ghostVisible: sessionManager._ghostVisible,
    skillId: sessionManager.currentSkillData?.id,
    wristX: sessionManager._lastWristX,
    wristY: sessionManager._lastWristY
});

  showPage('home');
  console.log('✓ App initialized with decoupled modules');
}

init();