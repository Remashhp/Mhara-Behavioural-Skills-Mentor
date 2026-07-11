/**
 * SkillMentor - Frontend Session Manager
 * Handles API orchestration and session lifecycle states.
 */



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
        this._lastWristX = null;
        this._lastWristY = null;

        // ── UI callbacks — assigned by app.js ──────────────
        // session.js NEVER touches the DOM. It only announces
        // events; app.js owns all rendering.
        this.onSkillLoaded = null;        // (skillData)
        this.onScoreUpdate = null;        // (score)
        this.onBPMUpdate = null;          // (bpm, isValid)
        this.onCompression = null;        // (count, rhythmValid)
        this.onDimensionFeedback = null;  // (dimId, message, isValid, showInFeed)
        this.onTimerTick = null;          // (remainingSeconds, urgent)
        this.onError = null;              // (message)
        this.onNotify = null;             // (message)
    }

    // ─────────────────────────────────────────────────────────
    // Public reset — the ONLY way to clear session state.
    // app.js must call this instead of touching internals.
    // ─────────────────────────────────────────────────────────
    reset() {
        this.isSessionActive = false;
        this.currentScore = 100.0;
        this.feedbackLog = [];
        this.frameCounter = 0;
        this._dimensionScores = {};
        this._ghostVisible = true;
        this._lastWristX = null;
        this._lastWristY = null;

        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        heuristicScorer.reset();
    }

    // ─────────────────────────────────────────────────────────
    // Start a New Session — Load Skill Data from criteria-db.js
    // ─────────────────────────────────────────────────────────
    async startSession(skillId) {
        try {

            // ① Load skill data from criteria-db.js (cache or API)            

            const skillData = await CRITERIA_DB.loadSkill(skillId);

            if (!skillData || !skillData.dimensions || skillData.dimensions.length === 0) {
                throw new Error(`المهارة ${skillId} ما تحتوي على dimensions`);
            }

            // ② Full state reset (includes heuristicScorer)
            this.reset();
            this.currentSkillData = skillData;

            console.log(`✓ Session started: ${skillData.name}`);

            // ③ Update the user interface
            this.onSkillLoaded?.(skillData);

            // ④ Duration comes exclusively from the model's extraction.
            // If the field is missing (corrupt/legacy row), we fall back
            // to a safe default AND tell the user — never silently.
            let duration = skillData.session_duration || skillData.session_duration_seconds;
            if (!duration) {
                duration = 60; // fail-safe only — never overrides model data
                this.onNotify?.('Session duration missing from extracted criteria — using a 60s fail-safe. Re-extract this skill.'); console.warn(`⚠ ${skillId}: session_duration missing — fail-safe 60s used`);
            }
            this._pendingDuration = duration;

            // Show the full duration on the badge while waiting
            this.onTimerTick?.(this._pendingDuration, false);

        } catch (error) {
            console.error("Session Start Failure:", error);
            this.onError?.("Failed to load skill data — make sure the server is running.");
        }
    }

    // ─────────────────────────────────────────────────────────
    // Called by app.js once the camera pipeline is live —
    // this is when the assessment clock actually starts.
    // ─────────────────────────────────────────────────────────
    beginAssessment() {
        this.isSessionActive = true;
        this._startTimer(this._pendingDuration || 60);
    }

    // ─────────────────────────────────────────────────────────
    // Process Each Camera Frame
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
            // CPR Evaluation
            // ══════════════════════════════════════════════════

            // Motion-based skills: amplitude + rhythm detection via the
            // scorer's rolling window (depth for CPR, upward thrust for
            // Heimlich — amplitude is direction-agnostic, works for both)
            const MOTION_SKILLS = new Set(["cpr", "heimlich"]);
            if (MOTION_SKILLS.has(this.currentSkillData.id)) {
                const pm = this.currentSkillData.primary_metric;
                const result = heuristicScorer.evaluateCpr(
                    dimension, signalValue,
                    pm.target_min, pm.target_max
                );

                if (result.type === "depth_and_rhythm") {
                    this._tally(dimension.id, result.isValid);
                    this.onDimensionFeedback?.(dimension.id, result.feedback, result.isValid,
                        this.frameCounter % 10 === 0, this._ratioOf(dimension.id));
                    if (result.rhythm) {
                        this._tally('cpr_rhythm', result.rhythm.isValid);
                        this.onBPMUpdate?.(result.rhythm.bpm, result.rhythm.isValid);
                        if (!result.rhythm.isValid) this.feedbackLog.push(result.rhythm.feedback);
                        this.onCompression?.(result.rhythm.count, result.rhythm.isValid);
                    }
                    this.currentScore = this._calcAverageScore();
                    this.onScoreUpdate?.(this.currentScore);
                    return;
                }
             this._tally(dimension.id, result.isValid);

                this.onDimensionFeedback?.(dimension.id, result.feedback, result.isValid,
                    this.frameCounter % 10 === 0, this._ratioOf(dimension.id));

                if (!result.isValid && this.frameCounter % 30 === 0) {
                    this.feedbackLog.push(result.feedback);
                }

                this.currentScore = this._calcAverageScore();
                this.onScoreUpdate?.(this.currentScore);
                return;
                
            }
            // ══════════════════════════════════════════════════
            // Generic Evaluation — All Other Skills
            // ══════════════════════════════════════════════════
            const evaluation = heuristicScorer.evaluateDimension(dimension, signalValue);

            this._tally(dimension.id, evaluation.isValid);
            this.currentScore = this._calcAverageScore();
            this.onDimensionFeedback?.(dimension.id, evaluation.feedback, evaluation.isValid,
                this.frameCounter % 10 === 0, this._ratioOf(dimension.id));
            if (!evaluation.isValid && this.frameCounter % 30 === 0) {
                this.feedbackLog.push(evaluation.feedback);
            }

            this.onScoreUpdate?.(this.currentScore);
        });
        // Hide the Ghost overlay once the user matches the target posture.
        if (this._ghostVisible
            && this.currentScore >= 70
            && Object.keys(this._dimensionScores).length > 0) {
            this._ghostVisible = false;
            console.log('✓ Ghost hidden — user aligned correctly');
        }
    }


    // ─────────────────────────────────────────────────────────
    // Time-weighted tally — each dimension accumulates
    // (valid frames / total frames) across the WHOLE session.
    // Final score = % of session time performed correctly.
    // No calibration constants needed — the ratio IS the score.
    // ─────────────────────────────────────────────────────────
    _tally(dimId, isValid) {
        if (!this._dimensionScores[dimId]) {
            this._dimensionScores[dimId] = { valid: 0, total: 0 };
        }
        this._dimensionScores[dimId].total++;
        if (isValid) this._dimensionScores[dimId].valid++;
    }
    _ratioOf(dimId) {
        const t = this._dimensionScores[dimId];
        return (t && t.total > 0) ? Math.round((t.valid / t.total) * 100) : null;
    }
    // ─────────────────────────────────────────────────────────
    // Calculate All 19 Signals
    // ─────────────────────────────────────────────────────────
    _calculateSignal(signalName, lm, handLm) {
        try {
            switch (signalName) {
              // ── Pose signals ──────────────────────────────
              case "wrist_center_x":
                const val = (lm[15].x + lm[16].x) / 2;
                this._lastWristX = val;
                this._lastWristY = (lm[15].y + lm[16].y) / 2;
                return val;

              case "wrist_center_y":
                return (lm[15].y + lm[16].y) / 2;

              case "arm_angle":
                return (
                  (this._angle(lm[11], lm[13], lm[15]) +
                    this._angle(lm[12], lm[14], lm[16])) /
                  2
                );

              case "elbow_angle":
                return Math.min(
                  this._angle(lm[11], lm[13], lm[15]),
                  this._angle(lm[12], lm[14], lm[16]),
                );
                this._lastElbowAngle = ea;
                return ea;

              case "body_lean":
                return (
                  Math.abs(
                    (lm[11].x + lm[12].x) / 2 - (lm[23].x + lm[24].x) / 2,
                  ) * 90
                );

              case "shoulder_level":
                return Math.abs(lm[11].y - lm[12].y);

              case "hand_height":
                // Signed: elbow height minus wrist height (image y grows
                // downward), so POSITIVE = hands ABOVE elbows.
                // Replaces the old shoulder-based absolute distance,
                // which was direction-blind and measured the wrong joint.
                return (lm[13].y + lm[14].y) / 2 - (lm[15].y + lm[16].y) / 2;

              case "wrist_to_navel_distance":
                const navel = {
                  x: (lm[23].x + lm[24].x) / 2,
                  y: (lm[23].y + lm[24].y) / 2,
                };
                const wristCenter = {
                  x: (lm[15].x + lm[16].x) / 2,
                  y: (lm[15].y + lm[16].y) / 2,
                };
                return this._distance(wristCenter, navel);

              case "shoulder_hip_angle":
                return (
                  (this._angle(lm[12], lm[24], lm[26]) +
                    this._angle(lm[11], lm[23], lm[25])) /
                  2
                );

              case "hip_knee_ankle_angle":
                // Back and hip angle — Shoulder–Hip–Knee (use the smaller angle)
                return Math.min(
                  this._angle(lm[11], lm[23], lm[25]),
                  this._angle(lm[12], lm[24], lm[26]),
                );

              case "wrist_to_body_center":
                const bodyCenter = {
                  x: (lm[11].x + lm[12].x) / 2,
                  y: (lm[11].y + lm[12].y) / 2,
                };
                const avgWrist = {
                  x: (lm[15].x + lm[16].x) / 2,
                  y: (lm[15].y + lm[16].y) / 2,
                };
                return this._distance(avgWrist, bodyCenter);

              case "knee_angle":
                // Knee angle — Hip–Knee–Ankle (average of both legs)
                return (
                  (this._angle(lm[23], lm[25], lm[27]) +
                    this._angle(lm[24], lm[26], lm[28])) /
                  2
                );

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
    // Geometric Calculations
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
    //  Hands signals
    // ─────────────────────────────────────────────────────────
    _fingerSpread(hand) {
        const tips = [4, 8, 12, 16, 20];
        let total = 0, count = 0;
        for (let i = 0; i < tips.length - 1; i++) {
            total += this._distance(hand[tips[i]], hand[tips[i + 1]]);
            count++;
        }
        return count > 0 ? total / count : 0;
    }

    _interdigitalCoverage(hand) {

        // Average distance between fingertip landmarks.       
        const bases = [2, 5, 9, 13, 17];
        let total = 0, count = 0;
        for (let i = 0; i < bases.length - 1; i++) {
            total += this._distance(hand[bases[i]], hand[bases[i + 1]]);
            count++;
        }
        return count > 0 ? total / count : 0;
    }

    _palmContact(hand1, hand2) {
        return this._distance(hand1[0], hand2[0]);
    }

    _wristRotation(hand) {
        const r = Math.atan2(
            hand[20].y - hand[4].y,
            hand[20].x - hand[4].x
        );
        return Math.abs(r * 180 / Math.PI);
    }

    _thumbCoverage(hand) {
        return this._distance(hand[4], hand[20]);
    }

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
    // end
    // ─────────────────────────────────────────────────────────
    _calcAverageScore() {
        const dimensions = this.currentSkillData?.dimensions || [];
        if (!dimensions.length) return 0;

        let weightedSum = 0;
        let totalWeight = 0;

        dimensions.forEach(dim => {
            const tally = this._dimensionScores[dim.id];
            if (!tally || tally.total === 0) return;
            const ratio = (tally.valid / tally.total) * 100;
            const weight = dim.weight ?? 1;
            weightedSum += ratio * weight;
            totalWeight += weight;
        });

        // CPR rhythm — pseudo-dimension derived from the primary
        // metric. Inherits the weight of the depth dimension
        // (wrist_center_y) — both measure the same primary metric,
        // so no new manual weight is introduced.
        const rhythmTally = this._dimensionScores['cpr_rhythm'];
        if (rhythmTally && rhythmTally.total > 0) {
            const depthDim = dimensions.find(d => d.pose_signal === 'wrist_center_y');
            const weight = depthDim?.weight ?? 1;
            weightedSum += (rhythmTally.valid / rhythmTally.total) * 100 * weight;
            totalWeight += weight;
        }

        if (!totalWeight) return 0;
        return Math.round(weightedSum / totalWeight);
    }

  endSession() {
    this.isSessionActive = false;
    this._ghostVisible = false;
    if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
    }

    const finalScore = Object.keys(this._dimensionScores).length > 0
        ? Math.round(this.currentScore)
        : 0;

    console.log(`✓ Session ended — Final Score: ${finalScore}%`);
    this.onSessionEnd?.(this.currentSkillData, finalScore, this.feedbackLog);
}



    _startTimer(seconds) {
        if (this.timerInterval) clearInterval(this.timerInterval);
        let remaining = seconds;

        this.onTimerTick?.(remaining, false);

        this.timerInterval = setInterval(() => {
            if (!this.isSessionActive || remaining <= 0) {
                clearInterval(this.timerInterval);
                if (remaining <= 0) this.endSession();
                return;
            }
            remaining--;
            this.onTimerTick?.(remaining, remaining <= 5);
        }, 1000);
    }


}

const sessionManager = new SkillSessionManager();