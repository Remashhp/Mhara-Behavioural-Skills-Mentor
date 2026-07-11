
const CRITERIA_DB = (() => {

  const API_BASE = CONFIG.API_BASE;
  let _cache = {};
  let _initialized = false;


let SKILL_CATALOG = [
      {
      id: "cpr",
      name: "CPR / Chest Compressions",
      emoji: "🫀",
      tag: "Basic Life Support",
      domain: "medical"
    },
    {
      id: "heimlich",
      name: "Heimlich Maneuver",
      emoji: "🤲",
      tag: "Emergency Response",
      domain: "medical"
    },
    {
      id: "hand_hygiene",
      name: "Hand Hygiene (WHO Technique)",
      emoji: "🧼",
      tag: "Infection Prevention",
      domain: "medical"
    },
    {
      id: "safe_lifting",
      name: "Safe Manual Lifting",
      emoji: "🏋️",
      tag: "Industrial Safety",
      domain: "industrial"
    }
  ];

  const DOMAIN_META = {
    medical: { name: "Medical", emoji: "🏥", tag: "Clinical Skills" },
    industrial: { name: "Industrial", emoji: "🏭", tag: "Safety Skills" }
  };

  // ── Signal registry — SINGLE source of truth in the frontend.
  // Must stay in sync with VALID_SIGNALS in main.py (backend
  // validates against its own copy; /api/health can be extended
  // to expose it for automated sync checking).
  const HAND_SIGNALS = new Set([
    "finger_spread", "interdigital_coverage", "palm_to_palm_contact",
    "wrist_rotation", "thumb_coverage", "fist_formation", "thumb_position"
  ]);

  function requiresHands(dimensions) {
    return (dimensions || []).some(d => HAND_SIGNALS.has(d.pose_signal));
  }

  async function init() {
    if (_initialized) return;

    try {
      console.log("📦 جاري تحميل قاعدة البيانات...");
      const response = await fetch(`${API_BASE}/skills/all`);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const count = Object.keys(data).length;

      if (count > 0) {
        _cache = data;
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
     // Catalog from backend — single source of truth.
    // Local SKILL_CATALOG above remains as offline fallback only.
    try {
      const res = await fetch(`${API_BASE}/skills`);
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list) && list.length > 0) {
          SKILL_CATALOG = list;
          console.log(`✓ Catalog loaded from backend (${list.length} skills)`);
        }
      }
    } catch (err) {
      console.warn("⚠ Catalog fetch failed — using local fallback:", err.message);
    }
  
  }

  async function loadSkill(skillId) {

    if (_cache[skillId]) {
      console.log(`⚡ من الكاش: ${skillId}`);
      return _cache[skillId];
    }

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
          source: { label: "Unavailable", url: "#" },
          session_duration: 30,
          primary_metric: {
            label: "Rate", unit: "", target_min: 0,
            target_max: 0, target_display: "—"
          },
          dimensions: [],
          improvement_tips: ["تعذر الاتصال بالسيرفر — تحقق من تشغيل الباك إند."]
        };
      }
      throw err;
    }
  }

  function getCatalog() {
    return SKILL_CATALOG;
  }

  function getDomainMeta() {
    return DOMAIN_META;
  }

  function clearCache(skillId) {
    if (skillId) {
      delete _cache[skillId];
      console.log(`🗑 تم مسح كاش ${skillId}`);
    } else {
      _cache = {};
      _initialized = false;
      console.log("🗑 تم مسح كل الكاش");
    }
  }

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
    isReady,
    requiresHands
  };

})();