/* ── CRITERIA DATABASE ───────────────────────────────────────
   يحمل بيانات المهارات من الباك إند مرة واحدة عند البداية.
   بعدها كل شي من الذاكرة — Gemini ما يتدخل إلا لمهارة جديدة.
   ─────────────────────────────────────────────────────────── */

const CRITERIA_DB = (() => {

  // ── إعدادات ──────────────────────────────────────────────
  const API_BASE = CONFIG.API_BASE;
  // ── الكاش الرئيسي ─────────────────────────────────────── 
  let _cache       = {};
  let _initialized = false;

  // ── كتالوج المهارات ───────────────────────────────────────
  // المصدر الوحيد للحقيقة للواجهة — بدون أي أرقام
  // domain يحدد في أي دومين تظهر المهارة
  const SKILL_CATALOG = [
    {
      id:     "cpr",
      name:   "CPR / Chest Compressions",
      emoji:  "🫀",
      tag:    "Basic Life Support",
      domain: "medical"
    },
    {
      id:     "heimlich",
      name:   "Heimlich Maneuver",
      emoji:  "🤲",
      tag:    "Emergency Response",
      domain: "medical"
    },
    {
      id:     "surgical_scrub",
      name:   "Surgical Hand Hygiene",
      emoji:  "🧼",
      tag:    "Aseptic Technique",
      domain: "medical"
    },
    {
      id:     "safe_lifting",
      name:   "Safe Manual Lifting",
      emoji:  "🏋️",
      tag:    "Industrial Safety",
      domain: "industrial"
    }
  ];

  // ── إعدادات الدومينات ─────────────────────────────────────
  // اسم وإيموجي كل دومين
  const DOMAIN_META = {
    medical:    { name: "Medical",    emoji: "🏥", tag: "Clinical Skills" },
    industrial: { name: "Industrial", emoji: "🏭", tag: "Safety Skills"   }
  };

  // ── تهيئة النظام ──────────────────────────────────────────
  async function init() {
    if (_initialized) return;

    try {
      console.log("📦 جاري تحميل قاعدة البيانات...");
      const response = await fetch(`${API_BASE}/skills/all`);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data  = await response.json();
      const count = Object.keys(data).length;

      if (count > 0) {
        _cache       = data;
        _initialized = true;
        console.log(`✓ تم تحميل ${count} مهارة من skills_db.json`);
      } else {
        console.warn("⚠ skills_db.json فارغ — المهارات ستُجلب عند الطلب");
        _initialized = true;
      }

    } catch (err) {
      console.warn("⚠ فشل تحميل قاعدة البيانات:", err.message);
      _initialized = true;
    }
  }

  // ── جيب مهارة واحدة ──────────────────────────────────────
  async function loadSkill(skillId) {

    // ١ — من الكاش المحلي
    if (_cache[skillId]) {
      console.log(`⚡ من الكاش: ${skillId}`);
      return _cache[skillId];
    }

    // ٢ — من الـ API (Gemini يستخرجها ويحفظها)
    try {
      console.log(`🌍 ${skillId} غير موجودة — جاري الاستخراج...`);
      const response = await fetch(`${API_BASE}/skills/load/${skillId}`);

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const skill = await response.json();

      if (!skill.dimensions || skill.dimensions.length === 0) {
        throw new Error(`المهارة ${skillId} ما تحتوي على dimensions`);
      }

      _cache[skillId] = skill;
      console.log(`✓ ${skillId} جاهزة — ${skill.dimensions.length} dimensions`);
      return skill;

    } catch (err) {
      console.error(`❌ فشل جلب ${skillId}:`, err.message);

      // Fallback — بيانات أساسية عشان الواجهة ما تنكسر
      const meta = SKILL_CATALOG.find(s => s.id === skillId);
      if (meta) {
        return {
          ...meta,
          source:           { label: "Unavailable", url: "#" },
          session_duration: 30,
          primary_metric: {
            label: "Rate", unit: "", target_min: 0,
            target_max: 0, target_display: "—"
          },
          dimensions:       [],
          improvement_tips: ["تعذر الاتصال بالسيرفر — تحقق من تشغيل الباك إند."]
        };
      }
      throw err;
    }
  }

  // ── جيب الكتالوج كاملاً ──────────────────────────────────
  function getCatalog() {
    return SKILL_CATALOG;
  }

  // ── جيب إعدادات الدومينات ────────────────────────────────
  function getDomainMeta() {
    return DOMAIN_META;
  }

  // ── امسح الكاش ───────────────────────────────────────────
  function clearCache(skillId) {
    if (skillId) {
      delete _cache[skillId];
      console.log(`🗑 تم مسح كاش ${skillId}`);
    } else {
      _cache       = {};
      _initialized = false;
      console.log("🗑 تم مسح كل الكاش");
    }
  }

  // ── هل المهارة محملة؟ ────────────────────────────────────
  function isReady(skillId) {
    return !!_cache[skillId];
  }

  // ── Public API ────────────────────────────────────────────
  return {
    init,
    loadSkill,
    getCatalog,
    getDomainMeta,
    clearCache,
    isReady
  };

})();