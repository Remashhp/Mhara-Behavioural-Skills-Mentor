/*
  SkillMentor - Optimized Pose + Hands Tracking Pipeline
  Total Tracking Points:
  - Pose: 33
  - Hands: 42
  = 75 Landmarks
*/

class SkillCameraManager {
    constructor() {
        this.videoElement = null;
        this.canvasElement = null;
        this.canvasCtx = null;

        this.pose = null;
        this.hands = null;
        this.camera = null;

        this.latestPose = null;
        this.latestHands = null;

        this.isPipelineReady = false;
        this.getSessionState = null;
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

    async initializePipeline(videoId, canvasId) {

        this.videoElement = document.getElementById(videoId);
        this.canvasElement = document.getElementById(canvasId);

        if (!this.videoElement || !this.canvasElement) {
            console.error("Missing video/canvas elements.");
            return;
        }

        this.canvasCtx = this.canvasElement.getContext("2d");

        // =========================
        // Pose Initialization
        // =========================

        this.pose = new Pose({
            locateFile: (file) =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
        });

        this.pose.setOptions({
            modelComplexity: 1,
            smoothLandmarks: true,
            enableSegmentation: false,
            minDetectionConfidence: 0.65,
            minTrackingConfidence: 0.65
        });

        this.pose.onResults((results) => {
            this.latestPose = results;
        });
        await this.pose.initialize();

        // =========================
        // Hands Initialization
        // =========================

        this.hands = new Hands({
            locateFile: (file) =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        });

        this.hands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.65,
            minTrackingConfidence: 0.65
        });

        this.hands.onResults((results) => {
            this.latestHands = results;
        });
        await this.hands.initialize();

        // =========================
        // Camera
        // =========================

        try {

            this.camera = new Camera(this.videoElement, {

                onFrame: async () => {

                    // إرسال الفريم للنموذجين معًا
                    await Promise.all([
                        this.pose.send({ image: this.videoElement }),
                        this.hands.send({ image: this.videoElement })
                    ]);
                    // رسم النتائج
                    this.renderFrame();
                },

                width: 640,
                height: 480
            });

            await this.camera.start();
            await this._startCountdown(3);

            this.isPipelineReady = true;

            console.log("Pose + Hands pipeline ready.");

        } catch (error) {
            console.error("Camera access failed:", error);
            throw error;
        }
    }

    renderFrame() {
        // إعادة تعيين حالة الـ Pose في كل إطار
        const poseStatusTxt = document.getElementById('poseStatusTxt');
        const poseDot = document.getElementById('poseDot');
        const poseLabel = document.getElementById('poseLabel');
        if (poseStatusTxt) { poseStatusTxt.textContent = 'DETECTING'; poseStatusTxt.style.color = 'var(--warn)'; }
        if (poseDot) { poseDot.style.background = 'var(--warn)'; }
        if (poseLabel) { poseLabel.textContent = 'Pose not detected'; }

        // تنظيف الكانفس
        this.canvasCtx.clearRect(
            0,
            0,
            this.canvasElement.width,
            this.canvasElement.height
        );

        // رسم صورة الكاميرا
        this.canvasCtx.drawImage(
            this.videoElement,
            0,
            0,
            this.canvasElement.width,
            this.canvasElement.height
        );

        // =========================
        // Draw Pose
        // =========================

        if (this.latestPose?.poseLandmarks) {

            drawConnectors(
                this.canvasCtx,
                this.latestPose.poseLandmarks,
                POSE_CONNECTIONS,
                {
                    color: "#00FF00",
                    lineWidth: 4
                }
            );

            drawLandmarks(
                this.canvasCtx,
                this.latestPose.poseLandmarks,
                {
                    color: "#FF0000",
                    lineWidth: 2,
                    radius: 4
                }
            );

            // إرسال البيانات للجلسة
            // إرسال البيانات للجلسة
            this.onFrame?.(
                this.latestPose.poseLandmarks,
                this.latestHands?.multiHandLandmarks ?? null
            );

            // تحديث حالة الـ Pose
            const poseStatusTxt = document.getElementById('poseStatusTxt');
            const poseDot = document.getElementById('poseDot');
            const poseLabel = document.getElementById('poseLabel');

            if (poseStatusTxt) { poseStatusTxt.textContent = 'DETECTED'; poseStatusTxt.style.color = 'var(--good)'; }
            if (poseDot) { poseDot.style.background = 'var(--good)'; }
            if (poseLabel) { poseLabel.textContent = 'Pose detected'; }

        }

        // =========================
        // Draw Hands
        // =========================

        if (this.latestHands?.multiHandLandmarks) {

            for (const landmarks of this.latestHands.multiHandLandmarks) {

                drawConnectors(
                    this.canvasCtx,
                    landmarks,
                    HAND_CONNECTIONS,
                    {
                        color: "#06b6d4",
                        lineWidth: 3
                    }
                );

                drawLandmarks(
                    this.canvasCtx,
                    landmarks,
                    {
                        color: "#FFFFFF",
                        lineWidth: 1,
                        radius: 2
                    }
                );
            }
        }

        const state = this.getSessionState?.();
        if (state?.ghostVisible) {
            if (state.skillId) this._drawGhost(state.skillId);
        }

    }
    // ─────────────────────────────────────────────────────────
    // Ghost Overlay — يظهر قبل بداية التقييم
    // يرسم وضعية مثالية للمهارة المختارة
    // ─────────────────────────────────────────────────────────
    _drawGhost(skillId) {
        const ctx = this.canvasCtx;
        const W = this.canvasElement.width || 640;
        const H = this.canvasElement.height || 480;

        // تأثير النبض
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
            // CPR — واقف فوق المريض، ذراعين مستقيمين
            // ══════════════════════════════════════════════════
            case 'cpr': {
                const pts = {
                    lSho: [0.36, 0.28], rSho: [0.64, 0.28],
                    lElb: [0.36, 0.46], rElb: [0.64, 0.46],
                    lWri: [0.48, 0.64], rWri: [0.52, 0.64],
                    lHip: [0.40, 0.60], rHip: [0.60, 0.60]
                };
                const p = k => [pts[k][0] * W, pts[k][1] * H];

                // خطوط الهيكل
                ctx.strokeStyle = color;
                ctx.lineWidth = 3.5;

                // كتفين
                this._line(ctx, p('lSho'), p('rSho'));

                // ذراع يسار مستقيم
                this._line(ctx, p('lSho'), p('lElb'));
                this._line(ctx, p('lElb'), p('lWri'));

                // ذراع يمين مستقيم
                this._line(ctx, p('rSho'), p('rElb'));
                this._line(ctx, p('rElb'), p('rWri'));

                // يدين فوق بعض — دائرة في المنتصف
                const mx = (p('lWri')[0] + p('rWri')[0]) / 2;
                const my = (p('lWri')[1] + p('rWri')[1]) / 2;

                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.arc(mx, my, W * 0.05, 0, Math.PI * 2);
                ctx.fillStyle = colorFill;
                ctx.fill();
                ctx.strokeStyle = colorWrist;
                ctx.stroke();

                // نقاط المفاصل
                ctx.setLineDash([]);
                ctx.shadowBlur = 0;
                const joints = ['lSho', 'rSho', 'lElb', 'rElb'];
                joints.forEach(k => this._dot(ctx, p(k), 5, color, colorFill));
                this._dot(ctx, p('lWri'), 7, colorWrist, colorFill);
                this._dot(ctx, p('rWri'), 7, colorWrist, colorFill);

                // نص توجيهي
                this._label(ctx, W / 2, H * 0.16, 'Align hands over sternum', pulse);
                break;
            }

            // ══════════════════════════════════════════════════
            // Heimlich — واقف خلف المريض، يدين حول البطن
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

                // كتفين
                this._line(ctx, p('lSho'), p('rSho'));

                // ذراع يسار — مثني للداخل
                this._line(ctx, p('lSho'), p('lElb'));
                this._line(ctx, p('lElb'), p('lWri'));

                // ذراع يمين — مثني للداخل
                this._line(ctx, p('rSho'), p('rElb'));
                this._line(ctx, p('rElb'), p('rWri'));

                // منطقة البطن — هدف الدفع
                const mx = (p('lWri')[0] + p('rWri')[0]) / 2;
                const my = (p('lWri')[1] + p('rWri')[1]) / 2;

                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.arc(mx, my, W * 0.07, 0, Math.PI * 2);
                ctx.fillStyle = colorFill;
                ctx.fill();
                ctx.strokeStyle = colorWrist;
                ctx.stroke();

                // سهم للأعلى والداخل
                ctx.setLineDash([]);
                ctx.strokeStyle = colorWrist;
                ctx.lineWidth = 2.5;
                this._arrow(ctx, mx, my + H * 0.06, mx, my - H * 0.04);

                // نقاط
                ctx.shadowBlur = 0;
                ['lSho', 'rSho', 'lElb', 'rElb'].forEach(k =>
                    this._dot(ctx, p(k), 5, color, colorFill));
                this._dot(ctx, p('lWri'), 7, colorWrist, colorFill);
                this._dot(ctx, p('rWri'), 7, colorWrist, colorFill);

                this._label(ctx, W / 2, H * 0.16, 'Position fist above navel — thrust inward & up', pulse);
                break;
            }

            // ══════════════════════════════════════════════════
            // Surgical Scrub — يدين مرفوعتين فوق الكوعين
            // ══════════════════════════════════════════════════
            case 'surgical_scrub': {
                const pts = {
                    lSho: [0.34, 0.32], rSho: [0.66, 0.32],
                    lElb: [0.30, 0.52], rElb: [0.70, 0.52],
                    lWri: [0.34, 0.36], rWri: [0.66, 0.36],
                };
                const p = k => [pts[k][0] * W, pts[k][1] * H];

                ctx.strokeStyle = color;
                ctx.lineWidth = 3.5;

                // كتفين
                this._line(ctx, p('lSho'), p('rSho'));

                // ذراع يسار — كوع منحني، يد مرفوعة فوق الكوع
                this._line(ctx, p('lSho'), p('lElb'));
                this._line(ctx, p('lElb'), p('lWri'));

                // ذراع يمين
                this._line(ctx, p('rSho'), p('rElb'));
                this._line(ctx, p('rElb'), p('rWri'));

                // خط مرجعي — مستوى الكوعين
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = `rgba(248, 81, 73, ${pulse * 0.6})`;
                ctx.lineWidth = 1.5;
                this._line(ctx,
                    [p('lElb')[0] - W * 0.08, p('lElb')[1]],
                    [p('rElb')[0] + W * 0.08, p('rElb')[1]]
                );

                // نص "Elbow level"
                ctx.setLineDash([]);
                ctx.font = `bold 11px 'DM Mono', monospace`;
                ctx.fillStyle = `rgba(248, 81, 73, ${pulse})`;
                ctx.textAlign = 'left';
                ctx.fillText('← Elbow level (hands must be above)', p('lElb')[0] - W * 0.07, p('lElb')[1] - 6);

                // دوائر اليدين — تشير للحركة الدائرية
                [p('lWri'), p('rWri')].forEach(pt => {
                    ctx.setLineDash([4, 3]);
                    ctx.strokeStyle = colorWrist;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(pt[0], pt[1], W * 0.04, 0, Math.PI * 1.5);
                    ctx.stroke();

                    // سهم دوران
                    this._arrow(ctx,
                        pt[0] + W * 0.04, pt[1],
                        pt[0] + W * 0.04, pt[1] - H * 0.02
                    );
                });

                // نقاط
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
            // Safe Lifting — ركبتين منحنيتين، ظهر مستقيم
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

                // جذع مستقيم
                const spineTop = [(p('lSho')[0] + p('rSho')[0]) / 2, (p('lSho')[1] + p('rSho')[1]) / 2];
                const spineBot = [(p('lHip')[0] + p('rHip')[0]) / 2, (p('lHip')[1] + p('rHip')[1]) / 2];
                ctx.setLineDash([]);
                ctx.strokeStyle = color;
                this._line(ctx, spineTop, spineBot);

                // كتفين وأوراك
                this._line(ctx, p('lSho'), p('rSho'));
                this._line(ctx, p('lHip'), p('rHip'));

                // ذراعين
                this._line(ctx, p('lSho'), p('lElb'));
                this._line(ctx, p('lElb'), p('lWri'));
                this._line(ctx, p('rSho'), p('rElb'));
                this._line(ctx, p('rElb'), p('rWri'));

                // أرجل منحنية
                this._line(ctx, p('lHip'), p('lKne'));
                this._line(ctx, p('lKne'), p('lAnk'));
                this._line(ctx, p('rHip'), p('rKne'));
                this._line(ctx, p('rKne'), p('rAnk'));

                // حمولة قريبة من الجسم
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

                // نقاط
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

    // ── مساعدات الرسم ─────────────────────────────────────
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
        ctx.fillText(text, x, y);
    }

    async destroy() {
        if (this.camera) { try { this.camera.stop(); } catch (e) { } }
        if (this.pose) { try { await this.pose.close(); } catch (e) { } }
        if (this.hands) { try { await this.hands.close(); } catch (e) { } }
        this.pose = null;
        this.hands = null;
        this.camera = null;
        this.isPipelineReady = false;
        this.getSessionState = null;
        console.log('✓ Pipeline destroyed');
    }

}

const skillCameraManager = new SkillCameraManager();