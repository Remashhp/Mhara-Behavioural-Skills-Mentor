/**
 * SkillMentor - Unified Heuristic Scoring Engine
 * كل منطق التقييم هنا — session.js يستدعي فقط
 */
class HeuristicScorer {

    constructor() {
        this.violationCounters = {};
        this.cprState = {
            lastDepthStatus: "up",
            compressionTimes: [],
            lastCompressionTimestamp: null,
            lastY: null,
            yHistory: [],
            dynamicThreshold: null
        };
    }

    // ─────────────────────────────────────────────────────────
    // صفّر كل الذاكرة عند بداية جلسة جديدة
    // ─────────────────────────────────────────────────────────
    reset() {
        this.violationCounters = {};
        this.cprState = {
            lastDepthStatus: "up",
            compressionTimes: [],
            lastCompressionTimestamp: null,
            lastY: null,
            yHistory: [],
            dynamicThreshold: null
        };
    }

    // ─────────────────────────────────────────────────────────
    // ① التقييم العام — كل المهارات
    // يقارن signalValue بـ perfect_min/max من Supabase
    // ─────────────────────────────────────────────────────────
    evaluateDimension(dimension, signalValue) {
        if (dimension.perfect_min === null || dimension.perfect_max === null) {
            return { isValid: true, feedback: dimension.good_feedback, shouldPenalize: false };
        }

        const isValid = signalValue >= dimension.perfect_min
            && signalValue <= dimension.perfect_max;

        if (!isValid) {
            const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
            if (!this.violationCounters[dimension.id]) {
                this.violationCounters[dimension.id] = { lastPenalty: now };
            }
            const elapsed = now - this.violationCounters[dimension.id].lastPenalty;
            const shouldPenalize = elapsed >= 500;
            if (shouldPenalize) {
                this.violationCounters[dimension.id].lastPenalty = now;
            }
            return { isValid: false, feedback: dimension.bad_feedback, shouldPenalize };
        }

        this.violationCounters[dimension.id] = null;
        return { isValid: true, feedback: dimension.good_feedback, shouldPenalize: false };
    }

    // ─────────────────────────────────────────────────────────
    // ② CPR — دالة موحدة تتعامل مع كل معايير الإنعاش
    // ─────────────────────────────────────────────────────────
    evaluateCpr(dimension, signalValue, wristYMax, wristYMin, bpmMin, bpmMax) {

        // عمق الضغط — amplitude detection
        if (dimension.pose_signal === "wrist_center_y") {
            const amplitude = wristYMax - wristYMin;
            const threshold = dimension.perfect_max;
            const isValid = amplitude >= threshold;
            const rhythm = this._cprRhythm(signalValue, bpmMin, bpmMax);
            return {
                type: "depth_and_rhythm",
                isValid,
                rhythm,
                feedback: isValid ? dimension.good_feedback : dimension.bad_feedback
            };
        }

        // إيقاع الضغط — state machine + تقييم الاستقامة
        if (dimension.pose_signal === "wrist_center_y") {
            const rhythm = this._cprRhythm(signalValue, bpmMin, bpmMax);
            const spatial = this.evaluateDimension(dimension, signalValue);
            return {
                type: "rhythm",
                rhythm,                      // BPM object أو null
                isValid: spatial.isValid,
                feedback: spatial.feedback
            };
        }

        // باقي معايير CPR — wrist_center_x و arm_angle
        return {
            type: "spatial",
            ...this.evaluateDimension(dimension, signalValue)
        };
    }

    // ─────────────────────────────────────────────────────────
    // State machine داخلية للـ CPR rhythm
    // ─────────────────────────────────────────────────────────
    _cprRhythm(wristY, bpmMin, bpmMax) {
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        if (this.cprState.lastY === null) {
            this.cprState.lastY = wristY;
            return null;
        }
        if (this.cprState.yHistory.length < 30) {
            this.cprState.yHistory.push(Math.abs(wristY - this.cprState.lastY));
            this.cprState.lastY = wristY;
            return null;
        }
        if (!this.cprState.dynamicThreshold) {
            const avgDelta = this.cprState.yHistory.reduce((a, b) => a + b, 0) / 30;
            this.cprState.dynamicThreshold = Math.max(0.001, avgDelta * 0.5);
        }
        const delta = wristY - this.cprState.lastY;
        this.cprState.lastY = wristY;
        if (delta > this.cprState.dynamicThreshold && this.cprState.lastDepthStatus === "up") {
            this.cprState.lastDepthStatus = "down";
        } else if (delta < -this.cprState.dynamicThreshold && this.cprState.lastDepthStatus === "down") {
            this.cprState.lastDepthStatus = "up";
            if (this.cprState.lastCompressionTimestamp !== null) {
                const elapsed = now - this.cprState.lastCompressionTimestamp;
                const dynamicMinTime = (60000 / bpmMax) * 0.6;
                if (elapsed > dynamicMinTime) {
                    this.cprState.compressionTimes.push(elapsed);
                    if (this.cprState.compressionTimes.length > 5) {
                        this.cprState.compressionTimes.shift();
                    }
                    const avg = this.cprState.compressionTimes.reduce((a, b) => a + b, 0)
                        / this.cprState.compressionTimes.length;
                    const bpm = Math.round(60000 / avg);
                    this.cprState.lastCompressionTimestamp = now;
                    const isValid = bpm >= bpmMin && bpm <= bpmMax;
                    return {
                        bpm,
                        isValid,
                        feedback: isValid ? "Perfect rhythm!" : bpm < bpmMin ? "Push faster!" : "Push slower!"
                    };
                }
            }
            this.cprState.lastCompressionTimestamp = now;
        }
        return null;
    }
}

const heuristicScorer = new HeuristicScorer();