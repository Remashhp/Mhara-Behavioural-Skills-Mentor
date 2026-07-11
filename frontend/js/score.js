/**
 * SkillMentor - Unified Heuristic Scoring Engine
 * All heuristic scoring logic is implemented here — session.js only invokes it.
 */

/**
 * Algorithm calibration constants.
 *
 * IMPORTANT — provenance note:
 * Clinical thresholds (perfect_min/max, BPM targets) come from the backend
 * with per-number source tracking. The constants below are ENGINEERING
 * calibration values (signal processing / UX pacing), chosen empirically
 * during development — they are NOT clinical guidelines.
 */
const SCORING_CONFIG = {


    // Frames collected to calibrate motion sensitivity before rhythm
    // detection starts. 30 frames ≈ 1 second at typical webcam FPS.
    CALIBRATION_FRAMES: 30,

    // Motion threshold = average calibration delta × this factor.
    // 0.5 filters camera noise while catching intentional movement.
    MOTION_SENSITIVITY_FACTOR: 0.5,

    // A compression interval must exceed (60000/bpmMax) × this factor
    // to count — rejects double-triggers from a single compression.
    MIN_INTERVAL_FACTOR: 0.6,

    // Compressions averaged for the displayed BPM. 5 balances stability
    // against responsiveness (~2.5s of data at target rate).
    BPM_ROLLING_WINDOW: 5,

    // Rolling window (frames) for compression-depth amplitude.
    // ~60 frames ≈ 2-3 compressions at target rate — replaces a
    // session-long max/min that froze depth evaluation.
    // Moved from session.js: depth logic belongs to the scorer.
    WRIST_WINDOW_FRAMES: 60
};

class HeuristicScorer {

    constructor() {
        this.cprState = {
            lastDepthStatus: "up",
            compressionTimes: [],
            lastCompressionTimestamp: null,
            lastY: null,
            yHistory: [],
            dynamicThreshold: null,
            wristYWindow: [],
            compressionCount: 0
        };
    }

    // ─────────────────────────────────────────────────────────
    // Reset all internal state before starting a new session.
    // ─────────────────────────────────────────────────────────
    reset() {
        this.cprState = {
            lastDepthStatus: "up",
            compressionTimes: [],
            lastCompressionTimestamp: null,
            lastY: null,
            yHistory: [],
            dynamicThreshold: null,
            wristYWindow: [],
            compressionCount: 0
        };
    }
    // ─────────────────────────────────────────────────────────
    // ① Generic Evaluation — Applies to All Skills
    // Compares the signal value against the perfect_min/max range from Supabase.
    // ──────────────────────────────────────────────────────────────────────────────────────────────────────────
    evaluateDimension(dimension, signalValue) {
        if (dimension.perfect_min === null || dimension.perfect_max === null) {
            return { isValid: true, feedback: dimension.good_feedback };
        }

        const isValid = signalValue >= dimension.perfect_min
            && signalValue <= dimension.perfect_max;

        return {
            isValid,
            feedback: isValid ? dimension.good_feedback : dimension.bad_feedback
        };
    }
    
    // ─────────────────────────────────────────────────────────
    // ② CPR Evaluation — Unified Logic for All CPR Criteria
    // Owns the rolling wristY window and compression counter.
    // session.js only passes the raw signal value.
    // ─────────────────────────────────────────────────────────

    evaluateCpr(dimension, signalValue, bpmMin, bpmMax) {

        // Compression depth — Amplitude detection over rolling window
        if (dimension.pose_signal === "wrist_center_y") {
            this.cprState.wristYWindow.push(signalValue);
            if (this.cprState.wristYWindow.length > SCORING_CONFIG.WRIST_WINDOW_FRAMES) {
                this.cprState.wristYWindow.shift();
            }

            const win = this.cprState.wristYWindow;
            const amplitude = Math.max(...win) - Math.min(...win);
            const threshold = dimension.perfect_max;
            const isValid = amplitude >= threshold;

            const rhythm = this._cprRhythm(signalValue, bpmMin, bpmMax);
            if (rhythm) {
                this.cprState.compressionCount++;
                rhythm.count = this.cprState.compressionCount;
            }

            return {
                type: "depth_and_rhythm",
                isValid,
                rhythm,
                feedback: isValid ? dimension.good_feedback : dimension.bad_feedback
            };
        }

        // Remaining CPR criteria — wrist_center_x and arm_angle
        return {
            type: "spatial",
            ...this.evaluateDimension(dimension, signalValue)
        };
    }
    // ─────────────────────────────────────────────────────────
    // Internal state machine for CPR rhythm detection
    // ─────────────────────────────────────────────────────────
    _cprRhythm(wristY, bpmMin, bpmMax) {
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        if (this.cprState.lastY === null) {
            this.cprState.lastY = wristY;
            return null;
        }
        if (this.cprState.yHistory.length < SCORING_CONFIG.CALIBRATION_FRAMES) {
            this.cprState.yHistory.push(Math.abs(wristY - this.cprState.lastY));
            this.cprState.lastY = wristY;
            return null;
        }
        if (!this.cprState.dynamicThreshold) {
            const avgDelta = this.cprState.yHistory.reduce((a, b) => a + b, 0) / SCORING_CONFIG.CALIBRATION_FRAMES;
            this.cprState.dynamicThreshold = Math.max(0.001, avgDelta * SCORING_CONFIG.MOTION_SENSITIVITY_FACTOR);
        }
        const delta = wristY - this.cprState.lastY;
        this.cprState.lastY = wristY;
        if (delta > this.cprState.dynamicThreshold && this.cprState.lastDepthStatus === "up") {
            this.cprState.lastDepthStatus = "down";
        } else if (delta < -this.cprState.dynamicThreshold && this.cprState.lastDepthStatus === "down") {
            this.cprState.lastDepthStatus = "up";
            if (this.cprState.lastCompressionTimestamp !== null) {
                const elapsed = now - this.cprState.lastCompressionTimestamp;
                const dynamicMinTime = (60000 / bpmMax) * SCORING_CONFIG.MIN_INTERVAL_FACTOR;
                if (elapsed > dynamicMinTime) {
                    this.cprState.compressionTimes.push(elapsed);
                    if (this.cprState.compressionTimes.length > SCORING_CONFIG.BPM_ROLLING_WINDOW) {
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