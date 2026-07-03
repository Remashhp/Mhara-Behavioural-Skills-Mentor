/**
 * SkillMentor - Frontend Session Manager
 * Handles API orchestration and session lifecycle states.
 */

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

class SkillSessionManager {

    constructor() {
        this.currentSkillData = null;
        this.isSessionActive = false;
        this.currentScore = 100.0;
        this.feedbackLog = [];
        this.frameCounter = 0;
        this.timerInterval = null;
        this._dimensionScores = {};
        this._ghostVisible = true;
        this._wristYMax = null;
        this._wristYMin = null;
    }

    // ─────────────────────────────────────────────────────────
    // بداية الجلسة — يجيب بيانات المهارة من criteria-db.js
    // ─────────────────────────────────────────────────────────
    async startSession(skillId) {
        try {
            // ① جيب البيانات من criteria-db.js (كاش أو API)
            const skillData = await CRITERIA_DB.loadSkill(skillId);

            if (!skillData || !skillData.dimensions || skillData.dimensions.length === 0) {
                throw new Error(`المهارة ${skillId} ما تحتوي على dimensions`);
            }

            this.currentSkillData = skillData;
            this.isSessionActive = true;
            this.currentScore = 100.0;
            this.feedbackLog = [];
            this.frameCounter = 0;
            this._dimensionScores = {};
            this._ghostVisible = true;
            this._wristYMax = null;
            this._wristYMin = null;
            // ② صفّر محرك التقييم
            heuristicScorer.reset();

            console.log(`✓ Session started: ${skillData.name}`);

            // ③ حدّث الواجهة
            this._updateUI(skillData);

            // ④ ابدأ العداد — يستخدم session_duration (من main.py)
            const duration = skillData.session_duration || skillData.session_duration_seconds || 60;
            this._startTimer(duration);

        } catch (error) {
            console.error("Session Start Failure:", error);
            this._showError("فشل تحميل بيانات المهارة — تأكد من تشغيل السيرفر.");
        }
    }

    // ─────────────────────────────────────────────────────────
    // معالجة كل فريم من الكاميرا
    // ─────────────────────────────────────────────────────────

    processFrame(poseLandmarks, handLandmarks = null) {
        if (!this.isSessionActive || !this.currentSkillData) return;

        this.frameCounter++;
        if (this.frameCounter < 5) return;

        this.currentSkillData.dimensions.forEach(dimension => {

            const signalValue = this._calculateSignal(
                dimension.pose_signal,
                poseLandmarks,
                handLandmarks
            );

            if (signalValue === null) return;

            // ══════════════════════════════════════════════════
            // التقييم  — cpr
            // ══════════════════════════════════════════════════

            if (this.currentSkillData.id === "cpr") {
                // حدّث الـ wristY أولاً
                if (dimension.pose_signal === "wrist_center_y") {
                    if (this._wristYMax === null) this._wristYMax = signalValue;
                    if (this._wristYMin === null) this._wristYMin = signalValue;
                    this._wristYMax = Math.max(this._wristYMax, signalValue);
                    this._wristYMin = Math.min(this._wristYMin, signalValue);

                }

                const pm = this.currentSkillData.primary_metric;
                const result = heuristicScorer.evaluateCpr(
                    dimension, signalValue, this._wristYMax, this._wristYMin,
                    pm.target_min, pm.target_max
                );

                if (result.type === "depth_and_rhythm") {
                    this._dimensionScores[dimension.id] = result.isValid ? 100 : 0;

                    if (result.rhythm) {
                        this._dimensionScores['cpr_rhythm'] = result.rhythm.isValid ? 100 : 0;
                        this._updateBPM(result.rhythm.bpm);
                        if (!result.rhythm.isValid) this.feedbackLog.push(result.rhythm.feedback);

                        if (!this._compressionCount) this._compressionCount = 0;
                        this._compressionCount++;
                        const countEl = document.getElementById('compCount');
                        const subEl = document.getElementById('compSub');
                        if (countEl) countEl.textContent = this._compressionCount;
                        if (subEl) subEl.textContent = `${this._compressionCount} compressions detected`;

                        // تحديث موجة الإيقاع
                        const wave = document.getElementById('rhythmWave');
                        if (wave) {
                            const bar = document.createElement('div');
                            bar.className = 'rhythm-bar';
                            bar.style.height = result.rhythm.isValid ? '100%' : '40%';
                            bar.style.background = result.rhythm.isValid ? 'var(--good)' : 'var(--warn)';
                            wave.appendChild(bar);
                            while (wave.children.length > 20) {
                                wave.removeChild(wave.firstChild);
                            }
                        }
                    }
                    return;
                }

                this._dimensionScores[dimension.id] = result.isValid ? 100 : 0;


                this._updateDimensionFeedback(dimension.id, result.feedback, result.isValid);

                this.currentScore = this._calcAverageScore();
                this._updateScoreUI(this.currentScore);
                return;
            }

            // ══════════════════════════════════════════════════
            // التقييم العام — كل المهارات الأخرى
            // ══════════════════════════════════════════════════
            const evaluation = heuristicScorer.evaluateDimension(dimension, signalValue);

            this._dimensionScores[dimension.id] = evaluation.isValid ? 100 : 0;
            this.currentScore = this._calcAverageScore();
            this._updateDimensionFeedback(dimension.id, evaluation.feedback, evaluation.isValid);

            if (!evaluation.isValid && this.frameCounter % 30 === 0) {
                this.feedbackLog.push(evaluation.feedback);
            }

            this._updateScoreUI(this.currentScore);
        });

        // Ghost يختفي لما المستخدم يطابق الوضعية
        if (this._ghostVisible
            && this.currentScore >= 70
            && Object.keys(this._dimensionScores).length > 0) {
            this._ghostVisible = false;
            console.log('✓ Ghost hidden — user aligned correctly');
        }
    }

    // ─────────────────────────────────────────────────────────
    // حساب الـ signals — 19 signal كاملة
    // ─────────────────────────────────────────────────────────
    _calculateSignal(signalName, lm, handLm) {
        try {
            switch (signalName) {

                // ── Pose signals ──────────────────────────────
                case "wrist_center_x":
                    return (lm[15].x + lm[16].x) / 2;

                case "wrist_center_y":
                    return (lm[15].y + lm[16].y) / 2;

                case "arm_angle":
                    return (
                        this._angle(lm[11], lm[13], lm[15]) +
                        this._angle(lm[12], lm[14], lm[16])
                    ) / 2;

                case "elbow_angle":
                    return Math.min(
                        this._angle(lm[11], lm[13], lm[15]),
                        this._angle(lm[12], lm[14], lm[16])
                    );
                case "body_lean":
                    return Math.abs(
                        ((lm[11].x + lm[12].x) / 2) -
                        ((lm[23].x + lm[24].x) / 2)
                    ) * 90;

                case "shoulder_level":
                    return Math.abs(lm[11].y - lm[12].y);

                case "hand_height":
                    return Math.abs(
                        (lm[15].y + lm[16].y) / 2 -
                        (lm[11].y + lm[12].y) / 2
                    );

                case "wrist_to_navel_distance":
                    const navel = {
                        x: (lm[23].x + lm[24].x) / 2,
                        y: (lm[23].y + lm[24].y) / 2
                    };
                    const wristCenter = {
                        x: (lm[15].x + lm[16].x) / 2,
                        y: (lm[15].y + lm[16].y) / 2
                    };
                    return this._distance(wristCenter, navel);

                case "shoulder_hip_angle":
                    return (
                        this._angle(lm[12], lm[24], lm[26]) +
                        this._angle(lm[11], lm[23], lm[25])
                    ) / 2;

                case "hip_knee_ankle_angle":
                    // زاوية الظهر والحوض — كتف-ورك-ركبة (أسوأ الاثنين)
                    return Math.min(
                        this._angle(lm[11], lm[23], lm[25]),
                        this._angle(lm[12], lm[24], lm[26])
                    );

                case "wrist_to_body_center":
                    const bodyCenter = {
                        x: (lm[11].x + lm[12].x) / 2,
                        y: (lm[11].y + lm[12].y) / 2
                    };
                    const avgWrist = {
                        x: (lm[15].x + lm[16].x) / 2,
                        y: (lm[15].y + lm[16].y) / 2
                    };
                    return this._distance(avgWrist, bodyCenter);

                case "knee_angle":
                    // زاوية الركبة — ورك-ركبة-كاحل (متوسط الاثنين)
                    return (
                        this._angle(lm[23], lm[25], lm[27]) +
                        this._angle(lm[24], lm[26], lm[28])
                    ) / 2;

                // ── Holistic Hands signals ────────────────────
                case "finger_spread":
                    if (!handLm || handLm.length === 0) return null;
                    return this._fingerSpread(handLm[0]);

                case "interdigital_coverage":
                    if (!handLm || handLm.length === 0) return null;
                    return this._interdigitalCoverage(handLm[0]);

                case "palm_to_palm_contact":
                    if (!handLm || handLm.length < 2) return null;
                    return this._palmContact(handLm[0], handLm[1]);

                case "wrist_rotation":
                    if (!handLm || handLm.length === 0) return null;
                    return this._wristRotation(handLm[0]);

                case "thumb_coverage":
                    if (!handLm || handLm.length === 0) return null;
                    return this._thumbCoverage(handLm[0]);

                case "fist_formation":
                    if (!handLm || handLm.length === 0) return null;
                    return this._fistFormation(handLm[0]);

                case "thumb_position":
                    if (!handLm || handLm.length === 0) return null;
                    return this._distance(handLm[0][4], handLm[0][8]);

                default:
                    console.warn(`⚠ signal غير معروف: ${signalName}`);
                    return null;
            }
        } catch (e) {
            console.error(`⚠ فشل حساب signal: ${signalName}`, e);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────
    // حسابات هندسية
    // ─────────────────────────────────────────────────────────
    _angle(p1, p2, p3) {
        const r = Math.atan2(p3.y - p2.y, p3.x - p2.x)
            - Math.atan2(p1.y - p2.y, p1.x - p2.x);
        let deg = Math.abs(r * 180 / Math.PI);
        if (deg > 180) deg = 360 - deg;
        return deg;
    }

    _distance(p1, p2) {
        return Math.sqrt(
            Math.pow(p2.x - p1.x, 2) +
            Math.pow(p2.y - p1.y, 2)
        );
    }

    // ─────────────────────────────────────────────────────────
    // حسابات Hands signals
    // ─────────────────────────────────────────────────────────
    _fingerSpread(hand) {
        // متوسط المسافة بين رؤوس الأصابع
        const tips = [4, 8, 12, 16, 20];
        let total = 0, count = 0;
        for (let i = 0; i < tips.length - 1; i++) {
            total += this._distance(hand[tips[i]], hand[tips[i + 1]]);
            count++;
        }
        return count > 0 ? total / count : 0;
    }

    _interdigitalCoverage(hand) {
        // متوسط المسافة بين قواعد الأصابع
        const bases = [2, 5, 9, 13, 17];
        let total = 0, count = 0;
        for (let i = 0; i < bases.length - 1; i++) {
            total += this._distance(hand[bases[i]], hand[bases[i + 1]]);
            count++;
        }
        return count > 0 ? total / count : 0;
    }

    _palmContact(hand1, hand2) {
        // المسافة بين راحتي اليدين
        return this._distance(hand1[0], hand2[0]);
    }

    _wristRotation(hand) {
        // زاوية دوران المعصم من خط الإبهام للخنصر
        const r = Math.atan2(
            hand[20].y - hand[4].y,
            hand[20].x - hand[4].x
        );
        return Math.abs(r * 180 / Math.PI);
    }

    _thumbCoverage(hand) {
        // مدى تغطية الإبهام — المسافة من طرف الإبهام لطرف الخنصر
        return this._distance(hand[4], hand[20]);
    }

    // قياس انغلاق القبضة — متوسط ثني الأصابع
    _fistFormation(hand) {
        const tips = [8, 12, 16, 20];
        const bases = [5, 9, 13, 17];
        let total = 0;
        tips.forEach((tip, i) => {
            total += this._distance(hand[tip], hand[bases[i]]);
        });
        return total / tips.length;
    }


    // ─────────────────────────────────────────────────────────
    // نهاية الجلسة
    // ─────────────────────────────────────────────────────────
    _calcAverageScore() {
        const dimensions = this.currentSkillData?.dimensions || [];
        if (!dimensions.length) return 0;

        let weightedSum = 0;
        let totalWeight = 0;

        dimensions.forEach(dim => {
            const score = this._dimensionScores[dim.id] ?? null;
            if (score === null) return;
            const weight = dim.weight ?? 1;
            weightedSum += score * weight;
            totalWeight += weight;
        });

        if (!totalWeight) return 0;
        return Math.round(weightedSum / totalWeight);
    }

    endSession() {
        this.isSessionActive = false;
        this._ghostVisible = false;
        this._wristYMax = null;
        this._wristYMin = null;
        this._compressionCount = 0;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }

        const finalScore = Object.keys(this._dimensionScores).length > 0
            ? Math.round(this.currentScore)
            : 0;
        console.log(`✓ Session ended — Final Score: ${finalScore}%`);

        // أرجع النتيجة لـ app.js عشان يعرضها
        this.onSessionEnd?.(this.currentSkillData, finalScore, this.feedbackLog);

    }

    // ─────────────────────────────────────────────────────────
    // مساعدات الواجهة
    // ─────────────────────────────────────────────────────────
    _updateUI(skillData) {
        const pm = skillData.primary_metric;
        const el = (id) => document.getElementById(id);

        if (el('skillBadgePractice')) el('skillBadgePractice').textContent = skillData.name;
        if (el('pmLabel')) el('pmLabel').textContent = pm?.label || 'Rate';
        if (el('pmTarget')) el('pmTarget').textContent = pm?.target_display || '—';
        if (el('pmUnit')) el('pmUnit').textContent = pm?.unit || '';
        if (el('session-status')) el('session-status').textContent = 'Session Active';

        // بناء صفوف الـ Live Scores
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
    }

    _updateDimensionFeedback(dimId, message, isValid) {
        const bar = document.getElementById(`sb-${dimId}`);
        const val = document.getElementById(`sv-${dimId}`);
        const color = isValid ? 'var(--good)' : 'var(--bad)';

        if (bar) {
            bar.style.width = isValid ? '85%' : '25%';
            bar.style.background = color;
        }
        if (val) {
            val.textContent = isValid ? '✓' : '✗';
            val.style.color = color;
        }

        // حدّث قائمة الفيدباك
        const feedbackList = document.getElementById('feedbackList');
        if (feedbackList && this.frameCounter % 10 === 0) {
            const cls = isValid ? 'fb-good' : 'fb-bad';
            const icon = isValid ? '✓' : '🔴';
            const item = document.createElement('div');
            item.className = `fb-item ${cls}`;
            item.innerHTML = `
        <span class="fb-icon">${icon}</span>
        <span>${escapeHTML(message)}</span>`;
            feedbackList.appendChild(item);

            // احتفظ بآخر 5 رسائل فقط
            while (feedbackList.children.length > 5) {
                feedbackList.removeChild(feedbackList.firstChild);
            }
        }
    }

    _updateScoreUI(score) {
        const el = document.getElementById('pmVal');
        if (el) {
            el.textContent = Math.round(score) + '%';
            el.className = score >= 80 ? 'color-good' : score >= 60 ? 'color-warn' : 'color-bad';
        }

        const bar = document.getElementById('pmBar');
        if (bar) bar.style.width = Math.round(score) + '%';

        const status = document.getElementById('pmStatus');
        if (status) {
            status.textContent = score >= 80 ? 'Excellent'
                : score >= 60 ? 'Good'
                    : 'Needs improvement';
        }
    }

    _updateBPM(bpm) {
        const el = document.getElementById('pmVal');
        if (el && this.currentSkillData?.id === 'cpr') {
            el.textContent = bpm;
            const pm = this.currentSkillData.primary_metric;
            el.className = (bpm >= pm.target_min && bpm <= pm.target_max)
                ? 'color-good' : 'color-warn';
        }
    }

    _startTimer(seconds) {
        if (this.timerInterval) clearInterval(this.timerInterval);
        let remaining = seconds;

        const timerEl = document.getElementById('timerDisp');

        const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (timerEl) timerEl.textContent = fmt(seconds);

        this.timerInterval = setInterval(() => {
            if (!this.isSessionActive || remaining <= 0) {
                clearInterval(this.timerInterval);
                if (remaining <= 0) this.endSession();
                return;
            }
            remaining--;
            if (timerEl) {
                timerEl.textContent = fmt(remaining);
                if (remaining <= 5) timerEl.classList.add('urgent');
                else timerEl.classList.remove('urgent');
            }
        }, 1000);
    }

    _showError(message) {
        const feedbackList = document.getElementById('feedbackList');
        if (feedbackList) {
            feedbackList.innerHTML = `
                <div class="fb-item fb-bad">
                    <span class="fb-icon">❌</span>
                    <span>${escapeHTML(message)}</span>
                </div>`;
        }
    }
}

const sessionManager = new SkillSessionManager();