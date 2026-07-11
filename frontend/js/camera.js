/*
  SkillMentor - Tracking Pipeline (MediaPipe Tasks Vision — Next Generation)
  - Pose is always loaded; Hands is loaded only for skills that require it.
  - GPU delegate with automatic fallback to CPU if WebGL fails.
  - Proper resource cleanup prevents WebGL context accumulation during retries.
*/

const MP_TASKS = {
    version: '0.10.14',
    get moduleUrl() {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${this.version}/vision_bundle.mjs`;
    },
    get wasmUrl() {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${this.version}/wasm`;
    },
    poseModel: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    handModel: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
};

class SkillCameraManager {
    constructor() {
        this.videoElement = null;
        this.canvasElement = null;
        this.canvasCtx = null;

        // Tasks Vision landmarkers
        this.poseLandmarker = null;
        this.handLandmarker = null;
        this.drawingUtils = null;

        // Library class references (used for connection constants)
        this._PoseLandmarker = null;
        this._HandLandmarker = null;
        // Direct browser camera access (without camera_utils)

        this._stream = null;
        this._frameHandle = null;
        this._usingRVFC = false;
        this._running = false;
        this._lastVideoTime = -1;
        this._gpuFrameFailures = 0;

        this.latestPose = null;
        this.latestHands = null;

        this.isPipelineReady = false;
    }

    _startCountdown(seconds) {
        return new Promise(resolve => {
            const camInner = document.querySelector('.cam-inner');
            if (!camInner) { resolve(); return; }
            const overlay = document.createElement('div');

            overlay.style.cssText = `
            position: absolute; inset: 0; z-index: 50;
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            background: rgba(0,0,0,0.7);
        `;
            overlay.innerHTML = `
            <div id="cdNum" style="
                font-size: 96px; font-weight: 800;
                color: #fff; line-height: 1;
                text-shadow: 0 0 40px rgba(78,163,151,0.8);
            ">${seconds}</div>
            <div style="
                margin-top: 16px; font-size: 15px;
                color: rgba(255,255,255,0.7);
                font-family: var(--fm); letter-spacing: 2px;
                text-transform: uppercase;
            ">Get ready...</div>
        `;

            camInner.appendChild(overlay);

            let count = seconds;
            const numEl = overlay.querySelector('#cdNum');

            const tick = setInterval(() => {
                count--;
                if (count > 0) {
                    numEl.textContent = count;
                } else {
                    clearInterval(tick);
                    overlay.remove();
                    resolve();
                }
            }, 1000);
        });
    }

    /**
     * @param {boolean} needsHands —  Passed from app.js based on the selected skill dimensions
     */
    async initializePipeline(videoId, canvasId, needsHands = false) {

        this.videoElement = document.getElementById(videoId);
        this.canvasElement = document.getElementById(canvasId);

        if (!this.videoElement || !this.canvasElement) {
            console.error("Missing video/canvas elements.");
            return;
        }

        this.canvasCtx = this.canvasElement.getContext("2d");

        try {

            // 1) Dynamically load the Tasks Vision library (ES Module)
            const vision = await import(MP_TASKS.moduleUrl);
            const { FilesetResolver, PoseLandmarker, HandLandmarker, DrawingUtils } = vision;
            this._PoseLandmarker = PoseLandmarker;
            this._HandLandmarker = HandLandmarker;

            const fileset = await FilesetResolver.forVisionTasks(MP_TASKS.wasmUrl);
            // 2) Pose — Always loaded. Try GPU first, then automatically fall back to CPU if WebGL fails.

            this.poseLandmarker = await this._createWithFallback(
                PoseLandmarker, fileset, this._buildModelOptions('pose', 'GPU')
            );

            // 3) Hands — Load only if the selected skill requires it.

            if (needsHands) {
                this.handLandmarker = await this._createWithFallback(
                    HandLandmarker, fileset, this._buildModelOptions('hands', 'GPU')
                );
            }

            this.drawingUtils = new DrawingUtils(this.canvasCtx);
            // 4) Access the camera directly using getUserMedia.

            this._stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 640 }, height: { ideal: 480 } },
                audio: false
            });
            this.videoElement.srcObject = this._stream;

            await new Promise((resolve) => {
                this.videoElement.onloadedmetadata = () => resolve();
            });
            await this.videoElement.play();
            // Set canvas dimensions based on the actual video size (fixes the gray screen issue).

            this.canvasElement.width = this.videoElement.videoWidth || 640;
            this.canvasElement.height = this.videoElement.videoHeight || 480;

            await this._startCountdown(3);
            // 5) Start the processing loop.

            this._running = true;
            this._lastVideoTime = -1;
            this._scheduleNextFrame();

            this.isPipelineReady = true;
            console.log(`✓ Tasks Vision pipeline ready — Pose${needsHands ? ' + Hands' : ' only'}.`);

        } catch (error) {
            console.error("Pipeline initialization failed:", error);
            await this.destroy();
            throw error;
        }
    }

    // ── Model options builder — single source for all four
    // creation sites (init GPU, init hands, CPU rebuild ×2).
    // Confidence 0.65: empirical calibration — high enough to
    // reject phantom detections, low enough for webcam lighting.
    _buildModelOptions(kind, delegate) {
        const CONFIDENCE = 0.65;
        const base = {
            runningMode: 'VIDEO'
        };
        if (kind === 'pose') {
            return {
                ...base,
                baseOptions: { modelAssetPath: MP_TASKS.poseModel, delegate },
                numPoses: 1,
                minPoseDetectionConfidence: CONFIDENCE,
                minPosePresenceConfidence: CONFIDENCE,
                minTrackingConfidence: CONFIDENCE
            };
        }
        return {
            ...base,
            baseOptions: { modelAssetPath: MP_TASKS.handModel, delegate },
            numHands: 2,
            minHandDetectionConfidence: CONFIDENCE,
            minHandPresenceConfidence: CONFIDENCE,
            minTrackingConfidence: CONFIDENCE
        };
    }

    // ── Create a Landmarker with Automatic GPU → CPU Fallback ──
    async _createWithFallback(TaskClass, fileset, options) {
        try {
            return await TaskClass.createFromOptions(fileset, options);
        } catch (gpuError) {
            console.warn(`⚠ GPU delegate فشل (${gpuError.message}) — التبديل إلى CPU...`);
            options.baseOptions.delegate = 'CPU';
            return await TaskClass.createFromOptions(fileset, options);
        }
    }

    // ── Schedule the Next Frame ──
    _scheduleNextFrame() {
        if (!this._running) return;

        const loop = () => this._processVideoFrame();

        if (typeof this.videoElement.requestVideoFrameCallback === 'function') {
            this._usingRVFC = true;
            this._frameHandle = this.videoElement.requestVideoFrameCallback(loop);
        } else {
            this._usingRVFC = false;
            this._frameHandle = requestAnimationFrame(loop);
        }
    }

    // ── Process a Single Video Frame ──
    _processVideoFrame() {
        if (!this._running || !this.poseLandmarker) return;

        const video = this.videoElement;
        // Do not process the same frame twice.

        if (video.readyState >= 2 && video.currentTime !== this._lastVideoTime) {
            this._lastVideoTime = video.currentTime;
            const timestamp = performance.now();

            try {
                this.latestPose = this.poseLandmarker.detectForVideo(video, timestamp);

                if (this.handLandmarker) {
                    this.latestHands = this.handLandmarker.detectForVideo(video, timestamp);
                }
            } catch (e) {
                console.warn('⚠ detectForVideo فشل لهذا الفريم:', e.message);

                // GPU delegate may initialize successfully but fail during execution
                // on some devices (e.g., activeTexture errors). After 10 consecutive
                // frame failures, rebuild the models using the CPU.


                this._gpuFrameFailures++;
                if (this._gpuFrameFailures === 10 && !this._cpuRetried) {
                    this._cpuRetried = true;
                    console.warn('⚠ GPU غير صالح على هذا الجهاز — إعادة البناء على CPU...');
                    this._rebuildOnCpu();
                    return; // // ── Rebuild Models on CPU After GPU Runtime Failure ──

                }
            }

            this.renderFrame();
        }

        this._scheduleNextFrame();
    }

    // Rebuild using the CPU.

    async _rebuildOnCpu() {
        this._running = false;

        try {
            const vision = await import(MP_TASKS.moduleUrl);
            const { FilesetResolver, PoseLandmarker, HandLandmarker } = vision;
            const fileset = await FilesetResolver.forVisionTasks(MP_TASKS.wasmUrl);

            const hadHands = !!this.handLandmarker;
            if (this.poseLandmarker) { try { this.poseLandmarker.close(); } catch (e) { } }
            if (this.handLandmarker) { try { this.handLandmarker.close(); } catch (e) { } }

            this.poseLandmarker = await PoseLandmarker.createFromOptions(
                fileset, this._buildModelOptions('pose', 'CPU')
            );

            if (hadHands) {
                this.handLandmarker = await HandLandmarker.createFromOptions(
                    fileset, this._buildModelOptions('hands', 'CPU')
                );
            }

            console.log('✓ النماذج أعيد بناؤها على CPU — استئناف المعالجة');

            this._running = true;
            this._lastVideoTime = -1;
            this._scheduleNextFrame();

        } catch (err) {
            console.error('❌ فشل إعادة البناء على CPU:', err);
        }
    }

    renderFrame() {
        // Tasks Vision output format:
        //
        // Pose:  { landmarks: [ [33 landmarks] ] }   ← First detected person only
        // Hands: { landmarks: [ [21], [21] ] }       ← Array of detected hands
        //
        // Each landmark uses the same {x, y, z} structure and indexing,
        // so session.js remains fully compatible.
        const poseLm = this.latestPose?.landmarks?.[0] ?? null;
        const handsLm = (this.latestHands?.landmarks?.length)
            ? this.latestHands.landmarks
            : null;

        const poseStatusTxt = document.getElementById('poseStatusTxt');
        const poseDot = document.getElementById('poseDot');
        const poseLabel = document.getElementById('poseLabel');
        if (poseStatusTxt) { poseStatusTxt.textContent = 'DETECTING'; poseStatusTxt.style.color = 'var(--warn)'; }
        if (poseDot) { poseDot.style.background = 'var(--warn)'; }
        if (poseLabel) { poseLabel.textContent = 'Pose not detected'; }

        // Clear the canvas and draw the camera frame.

        this.canvasCtx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
        this.canvasCtx.drawImage(this.videoElement, 0, 0, this.canvasElement.width, this.canvasElement.height);

        // ── Draw Pose ──
        if (poseLm) {
            this.drawingUtils.drawConnectors(
                poseLm,
                this._PoseLandmarker.POSE_CONNECTIONS,
                { color: "#00FF00", lineWidth: 4 }
            );
            this.drawingUtils.drawLandmarks(
                poseLm,
                { color: "#FF0000", lineWidth: 2, radius: 4 }
            );


            this.onFrame?.(poseLm, handsLm);

            if (poseStatusTxt) { poseStatusTxt.textContent = 'DETECTED'; poseStatusTxt.style.color = 'var(--good)'; }
            if (poseDot) { poseDot.style.background = 'var(--good)'; }
            if (poseLabel) { poseLabel.textContent = 'Pose detected'; }
        }

        // ── Draw Hands ──
        if (handsLm) {
            for (const landmarks of handsLm) {
                this.drawingUtils.drawConnectors(
                    landmarks,
                    this._HandLandmarker.HAND_CONNECTIONS,
                    { color: "#06b6d4", lineWidth: 3 }
                );
                this.drawingUtils.drawLandmarks(
                    landmarks,
                    { color: "#FFFFFF", lineWidth: 1, radius: 2 }
                );
            }
        }

        const state = this.getSessionState?.();
        if (state?.ghostVisible) {
            if (state.skillId) this._drawGhost(state.skillId);
        }

    }
    // ─────────────────────────────────────────────────────────
    // Ghost Overlay
    // Displays the ideal pose before the assessment begins.
    // Visualizes the target posture for the selected skill.
    // ─────────────────────────────────────────────────────────
    _drawGhost(skillId) {
        const ctx = this.canvasCtx;
        const W = this.canvasElement.width || 640;
        const H = this.canvasElement.height || 480;

        // Pulse animation.

        const pulse = 0.75 + 0.2 * Math.sin(Date.now() / 900);

        const color = `rgba(78, 163, 151, ${pulse})`;
        const colorFill = `rgba(78, 163, 151, ${pulse * 0.25})`;
        const colorWrist = `rgba(250, 204, 21, ${pulse})`;

        ctx.save();
        ctx.setLineDash([8, 6]);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = 'rgba(78, 163, 151, 0.6)';
        ctx.shadowBlur = 16;

        switch (skillId) {

            // ══════════════════════════════════════════════════
            // CPR 
            // ══════════════════════════════════════════════════
            case 'cpr': {
                const pts = {
                    lSho: [0.36, 0.28], rSho: [0.64, 0.28],
                    lElb: [0.36, 0.46], rElb: [0.64, 0.46],
                    lWri: [0.48, 0.64], rWri: [0.52, 0.64],
                    lHip: [0.40, 0.60], rHip: [0.60, 0.60]
                };
                const p = k => [pts[k][0] * W, pts[k][1] * H];

                ctx.strokeStyle = color;
                ctx.lineWidth = 3.5;

                this._line(ctx, p('lSho'), p('rSho'));

                // Straight left arm
                this._line(ctx, p('lSho'), p('lElb'));
                this._line(ctx, p('lElb'), p('lWri'));

                // Straight right arm
                this._line(ctx, p('rSho'), p('rElb'));
                this._line(ctx, p('rElb'), p('rWri'));

                // Hands overlapping — circle in the center
                const mx = (p('lWri')[0] + p('rWri')[0]) / 2;
                const my = (p('lWri')[1] + p('rWri')[1]) / 2;

                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.arc(mx, my, W * 0.05, 0, Math.PI * 2);
                ctx.fillStyle = colorFill;
                ctx.fill();
                ctx.strokeStyle = colorWrist;
                ctx.stroke();

                // Joint points
                ctx.setLineDash([]);
                ctx.shadowBlur = 0;
                const joints = ['lSho', 'rSho', 'lElb', 'rElb'];
                joints.forEach(k => this._dot(ctx, p(k), 5, color, colorFill));
                this._dot(ctx, p('lWri'), 7, colorWrist, colorFill);
                this._dot(ctx, p('rWri'), 7, colorWrist, colorFill);

               // Instructional text
                // Show live arrow from actual wrists to target center
const sessionState = this.getSessionState?.();
if (sessionState?.wristX !== undefined) {
    const actualX = sessionState.wristX * W;
    const actualY = (sessionState.wristY || 0.64) * H;
    const targetX = mx;
    const targetY = my;
    const dx = targetX - actualX;
    const dy = targetY - actualY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > W * 0.05) {
        // Draw arrow from actual to target
        ctx.strokeStyle = `rgba(255, 100, 100, ${pulse})`;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(actualX, actualY);
        ctx.lineTo(targetX, targetY);
        ctx.stroke();
        this._label(ctx, W / 2, H * 0.16, 'Move hands to center ↓', pulse);
    } else {
        this._label(ctx, W / 2, H * 0.16, '✓ Hands centered!', pulse);
    }
} else {
    this._label(ctx, W / 2, H * 0.16, 'Align hands over sternum', pulse);
}
                break;
            }

            // ══════════════════════════════════════════════════
            // Heimlich 
            // ══════════════════════════════════════════════════
            case 'heimlich': {
                const pts = {
                    lSho: [0.30, 0.28], rSho: [0.58, 0.28],
                    lElb: [0.22, 0.46], rElb: [0.66, 0.46],
                    lWri: [0.38, 0.58], rWri: [0.50, 0.58],
                    lHip: [0.36, 0.62], rHip: [0.56, 0.62]
                };
                const p = k => [pts[k][0] * W, pts[k][1] * H];

                ctx.strokeStyle = color;
                ctx.lineWidth = 3.5;


                this._line(ctx, p('lSho'), p('rSho'));


                this._line(ctx, p('lSho'), p('lElb'));
                this._line(ctx, p('lElb'), p('lWri'));


                this._line(ctx, p('rSho'), p('rElb'));
                this._line(ctx, p('rElb'), p('rWri'));


                const mx = (p('lWri')[0] + p('rWri')[0]) / 2;
                const my = (p('lWri')[1] + p('rWri')[1]) / 2;

                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.arc(mx, my, W * 0.07, 0, Math.PI * 2);
                ctx.fillStyle = colorFill;
                ctx.fill();
                ctx.strokeStyle = colorWrist;
                ctx.stroke();


                ctx.setLineDash([]);
                ctx.strokeStyle = colorWrist;
                ctx.lineWidth = 2.5;
                this._arrow(ctx, mx, my + H * 0.06, mx, my - H * 0.04);


                ctx.shadowBlur = 0;
                ['lSho', 'rSho', 'lElb', 'rElb'].forEach(k =>
                    this._dot(ctx, p(k), 5, color, colorFill));
                this._dot(ctx, p('lWri'), 7, colorWrist, colorFill);
                this._dot(ctx, p('rWri'), 7, colorWrist, colorFill);

                this._label(ctx, W / 2, H * 0.16, 'Position fist above navel — thrust inward & up', pulse);
                break;
            }

            // ══════════════════════════════════════════════════
            // Hand Hygiene
           // ══════════════════════════════════════════════════
            case 'hand_hygiene': {
                const pts = {
                    lSho: [0.34, 0.32], rSho: [0.66, 0.32],
                    lElb: [0.30, 0.52], rElb: [0.70, 0.52],
                    lWri: [0.34, 0.36], rWri: [0.66, 0.36],
                };
                const p = k => [pts[k][0] * W, pts[k][1] * H];

                ctx.strokeStyle = color;
                ctx.lineWidth = 3.5;


                this._line(ctx, p('lSho'), p('rSho'));


                this._line(ctx, p('lSho'), p('lElb'));
                this._line(ctx, p('lElb'), p('lWri'));


                this._line(ctx, p('rSho'), p('rElb'));
                this._line(ctx, p('rElb'), p('rWri'));


                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = `rgba(248, 81, 73, ${pulse * 0.6})`;
                ctx.lineWidth = 1.5;
                this._line(ctx,
                    [p('lElb')[0] - W * 0.08, p('lElb')[1]],
                    [p('rElb')[0] + W * 0.08, p('rElb')[1]]
                );


                ctx.setLineDash([]);
                ctx.font = `bold 11px 'DM Mono', monospace`;
                ctx.fillStyle = `rgba(248, 81, 73, ${pulse})`;
                ctx.textAlign = 'left';
                ctx.fillText('← Elbow level (hands must be above)', p('lElb')[0] - W * 0.07, p('lElb')[1] - 6);


                [p('lWri'), p('rWri')].forEach(pt => {
                    ctx.setLineDash([4, 3]);
                    ctx.strokeStyle = colorWrist;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(pt[0], pt[1], W * 0.04, 0, Math.PI * 1.5);
                    ctx.stroke();


                    this._arrow(ctx,
                        pt[0] + W * 0.04, pt[1],
                        pt[0] + W * 0.04, pt[1] - H * 0.02
                    );
                });


                ctx.setLineDash([]);
                ctx.shadowBlur = 0;
                ['lSho', 'rSho', 'lElb', 'rElb'].forEach(k =>
                    this._dot(ctx, p(k), 5, color, colorFill));
                this._dot(ctx, p('lWri'), 7, colorWrist, colorFill);
                this._dot(ctx, p('rWri'), 7, colorWrist, colorFill);

                this._label(ctx, W / 2, H * 0.16, 'Hands above elbows — scrub in circular motion', pulse);
                break;
            }

            // ══════════════════════════════════════════════════
            // Safe Lifting 
            // ══════════════════════════════════════════════════
            case 'safe_lifting': {
                const pts = {
                    lSho: [0.36, 0.22], rSho: [0.64, 0.22],
                    lElb: [0.32, 0.38], rElb: [0.68, 0.38],
                    lWri: [0.36, 0.52], rWri: [0.64, 0.52],
                    lHip: [0.38, 0.52], rHip: [0.62, 0.52],
                    lKne: [0.34, 0.70], rKne: [0.66, 0.70],
                    lAnk: [0.36, 0.88], rAnk: [0.64, 0.88]
                };
                const p = k => [pts[k][0] * W, pts[k][1] * H];

                ctx.strokeStyle = color;
                ctx.lineWidth = 3.5;

                const spineTop = [(p('lSho')[0] + p('rSho')[0]) / 2, (p('lSho')[1] + p('rSho')[1]) / 2];
                const spineBot = [(p('lHip')[0] + p('rHip')[0]) / 2, (p('lHip')[1] + p('rHip')[1]) / 2];
                ctx.setLineDash([]);
                ctx.strokeStyle = color;
                this._line(ctx, spineTop, spineBot);

                this._line(ctx, p('lSho'), p('rSho'));
                this._line(ctx, p('lHip'), p('rHip'));

                this._line(ctx, p('lSho'), p('lElb'));
                this._line(ctx, p('lElb'), p('lWri'));
                this._line(ctx, p('rSho'), p('rElb'));
                this._line(ctx, p('rElb'), p('rWri'));

                this._line(ctx, p('lHip'), p('lKne'));
                this._line(ctx, p('lKne'), p('lAnk'));
                this._line(ctx, p('rHip'), p('rKne'));
                this._line(ctx, p('rKne'), p('rAnk'));

                const loadX = (p('lWri')[0] + p('rWri')[0]) / 2;
                const loadY = (p('lWri')[1] + p('rWri')[1]) / 2;
                ctx.setLineDash([5, 4]);
                ctx.strokeStyle = colorWrist;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.roundRect(loadX - W * 0.06, loadY - H * 0.04, W * 0.12, H * 0.08, 6);
                ctx.fillStyle = colorFill;
                ctx.fill();
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.shadowBlur = 0;
                ['lSho', 'rSho', 'lElb', 'rElb', 'lHip', 'rHip', 'lKne', 'rKne'].forEach(k =>
                    this._dot(ctx, p(k), 5, color, colorFill));
                this._dot(ctx, p('lWri'), 7, colorWrist, colorFill);
                this._dot(ctx, p('rWri'), 7, colorWrist, colorFill);
                this._dot(ctx, p('lAnk'), 4, color, colorFill);
                this._dot(ctx, p('rAnk'), 4, color, colorFill);

                this._label(ctx, W / 2, H * 0.10, 'Bend knees — keep back straight — load close to body', pulse);
                break;
            }

            default:
                break;
        }

        ctx.restore();
    }
    // ── Drawing Helpers ─────────────────────────────────────

    _line(ctx, a, b) {
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
    }

    _dot(ctx, p, r, stroke, fill) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.stroke();
    }

    _arrow(ctx, x1, y1, x2, y2) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        const angle = Math.atan2(y2 - y1, x2 - x1);
        const size = 8;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - size * Math.cos(angle - 0.4), y2 - size * Math.sin(angle - 0.4));
        ctx.lineTo(x2 - size * Math.cos(angle + 0.4), y2 - size * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fill();
    }

    _label(ctx, x, y, text, pulse) {
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
        ctx.font = `bold 13px 'DM Sans', sans-serif`;
        ctx.fillStyle = `rgba(217, 249, 157, ${pulse})`;
        ctx.textAlign = 'center';

        // The canvas is mirrored via CSS (selfie view) which flips text.
        // Pre-flip the text horizontally around its anchor so it reads
        // correctly after the CSS mirror is applied.
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(-1, 1);
        ctx.fillText(text, 0, 0);
        ctx.restore();
    }

    async destroy() {
        this._running = false;
        if (this._frameHandle !== null) {
            try {
                if (this._usingRVFC && this.videoElement?.cancelVideoFrameCallback) {
                    this.videoElement.cancelVideoFrameCallback(this._frameHandle);
                } else {
                    cancelAnimationFrame(this._frameHandle);
                }
            } catch (e) { }
            this._frameHandle = null;
        }

        if (this._stream) {
            try { this._stream.getTracks().forEach(t => t.stop()); } catch (e) { }
            this._stream = null;
        }
        if (this.videoElement) {
            try { this.videoElement.srcObject = null; } catch (e) { }
        }

        if (this.poseLandmarker) { try { this.poseLandmarker.close(); } catch (e) { } }
        if (this.handLandmarker) { try { this.handLandmarker.close(); } catch (e) { } }
        this.poseLandmarker = null;
        this.handLandmarker = null;
        this.drawingUtils = null;

        this.latestPose = null;
        this.latestHands = null;
        this._lastVideoTime = -1;
        this._gpuFrameFailures = 0;
        this._cpuRetried = false;
        this.isPipelineReady = false;
        console.log('✓ Pipeline destroyed — all resources released');
    }

}

const skillCameraManager = new SkillCameraManager();