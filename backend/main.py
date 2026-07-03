from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx
from bs4 import BeautifulSoup
import json
import os
import uvicorn
from google import genai
from supabase import create_client, Client
from dotenv import load_dotenv
from fastapi import Header
import trafilatura

# =========================================================================
# 1. إعدادات
# =========================================================================
load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
SUPABASE_URL   = os.getenv("SUPABASE_URL")
SUPABASE_KEY   = os.getenv("SUPABASE_KEY")
API_SECRET = os.getenv("API_SECRET", "")

client   = genai.Client(api_key=GEMINI_API_KEY)
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
_db_cache: dict = {}
_db_cache_valid = False

app = FastAPI(title="BSM Protocol Engine", version="5.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
    "http://localhost:5500",      # فرونت إند محلي عبر VS Code Live Server
    "http://127.0.0.1:5500",      # نفس الشي — عنوان بديل للـ localhost
    # "https://your-app.vercel.app" # أضف دومين موقعك هنا لما ترفعه على الإنترنت
],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================================================================
# 2. القيم الصالحة — يجب أن تتطابق مع session.js و camera.js
# =========================================================================
VALID_SIGNALS = {
    # Pose (12)
    "wrist_center_x",
    "wrist_center_y",
    "arm_angle",
    "elbow_angle",
    "body_lean",
    "shoulder_level",
    "hand_height",
    "wrist_to_navel_distance",
    "shoulder_hip_angle",
    "hip_knee_ankle_angle",
    "wrist_to_body_center",
    "knee_angle",
    # Hands (7)
    "finger_spread",
    "interdigital_coverage",
    "palm_to_palm_contact",
    "wrist_rotation",
    "thumb_coverage",
    "fist_formation",
    "thumb_position"
}

# نطاقات منطقية — لرفض القيم المستحيلة من Gemini
SIGNAL_SANITY = {
    "wrist_center_x":          (0.0,  1.0),
    "wrist_center_y":          (0.0,  1.0),
    "arm_angle":               (90,   180),
    "elbow_angle":             (60,   180),
    "body_lean":               (0,    60),
    "shoulder_level":          (0.0,  0.5),
    "hand_height":             (0.0,  1.0),
    "wrist_to_navel_distance": (0.0,  1.0),
    "shoulder_hip_angle":      (90,   180),
    "hip_knee_ankle_angle":    (60,   180),
    "wrist_to_body_center":    (0.0,  1.0),
    "knee_angle":              (60,   180),
    "finger_spread":           (0.0,  1.0),
    "interdigital_coverage":   (0.0,  1.0),
    "palm_to_palm_contact":    (0.0,  1.0),
    "wrist_rotation":          (0,    360),
    "thumb_coverage":          (0.0,  1.0),
    "fist_formation":          (0.0,  1.0),
    "thumb_position":          (0.0,  1.0)
}

# وصف كل signal — يُبنى تلقائياً في الـ prompt
SIGNAL_DESCRIPTIONS = {
    "wrist_center_x":          "horizontal hand position (0.0–1.0, center=0.5)",
    "wrist_center_y":          "vertical hand position (0.0–1.0, use amplitude for depth)",
    "arm_angle":               "elbow extension in degrees (170–180° = straight)",
    "elbow_angle":             "elbow bend in degrees (90° = perpendicular)",
    "body_lean":               "torso lean in degrees (10–20° = upright)",
    "shoulder_level":          "shoulder height difference (0.0 = level)",
    "hand_height":             "hands height vs elbows (0.45 = above elbows)",
    "wrist_to_navel_distance": "wrist distance from navel (0.0–1.0)",
    "shoulder_hip_angle":      "shoulder to hip angle in degrees (180° = upright)",
    "hip_knee_ankle_angle":    "hip to knee to ankle angle in degrees (180° = straight leg)",
    "wrist_to_body_center":    "wrist distance from body center (0.0–1.0)",
    "knee_angle":              "knee bend angle in degrees (90° = full squat)",
    "finger_spread":           "finger separation distance (0.0–1.0)",
    "interdigital_coverage":   "coverage between fingers (0.0–1.0)",
    "palm_to_palm_contact":    "palm contact proximity (0.0–1.0)",
    "wrist_rotation":          "wrist rotation in degrees (0–360°)",
    "thumb_coverage":          "thumb coverage area (0.0–1.0)",
    "fist_formation":          "fist formation quality (0.0–1.0)",
    "thumb_position":          "thumb tip position (0.0–1.0)"
}

def build_signal_rule() -> str:
    """يبني RULE 1 تلقائياً من VALID_SIGNALS — لا تعديل يدوي مطلوب"""
    lines = [f"RULE 1 — pose_signal MUST be EXACTLY one of these {len(VALID_SIGNALS)} values:"]
    for signal in sorted(VALID_SIGNALS):
        desc = SIGNAL_DESCRIPTIONS.get(signal, "")
        lines.append(f"  - {signal:<30} → {desc}")
    return "\n".join(lines)

# =========================================================================
# 3. كتالوج المهارات
# =========================================================================
STATIC_PROTOCOLS = {
    "cpr": {
        "url":   "https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines",
        "emoji": "🫀",
        "tag":   "Basic Life Support",
       "measurement_hint": (
    # عمق الضغط
    "Use wrist_center_y to measure compression depth via amplitude detection. "
    "The perfect_max represents the minimum required wrist movement amplitude "
    "that corresponds to AHA guideline of minimum 2 inches (5cm) compression depth. "

    # معدل الضغط
    "Use elbow_angle for compression rate state machine. "
    "Set perfect_min and perfect_max to represent the DOWN phase "
    "where elbows bend during active compression. "

    # موضع اليد
    "Use wrist_center_x for hand centering on sternum. "
    "Set perfect_min and perfect_max to represent the center of the chest "
    "based on AHA guideline: hands at center of sternum. "

    # استقامة الذراع
    "Use arm_angle for arm straightness during compressions. "
    "Set perfect_min and perfect_max to represent fully extended straight arms "
    "based on AHA guideline: locked elbows for effective force transfer. "

    "IMPORTANT: Always include all 4 dimensions in this exact order: "
    "wrist_center_y, elbow_angle, wrist_center_x, arm_angle."
)
    },
    "heimlich": {
        "url":   "https://my.clevelandclinic.org/health/treatments/21675-heimlich-maneuver",
        "emoji": "🤲",
        "tag":   "Emergency Response",
        "measurement_hint": (
            "Use wrist_center_x inward movement to detect abdominal thrust direction. "
            "Use shoulder_hip_angle to verify rescuer is positioned behind the patient. "
            "Use elbow_angle to verify correct arm bend during thrust. "
            "Use body_lean to verify forward positioning."
        )
    },
    "surgical_scrub": {
    "url": "https://www.ncbi.nlm.nih.gov/books/NBK144013/",
        "emoji": "🧼",
        "tag":   "Aseptic Technique",
        "measurement_hint": (
            "Use finger_spread to verify fingers are separated for coverage. "
            "Use wrist_rotation to verify rotational scrubbing motion. "
            "Use palm_to_palm_contact to verify bilateral hand contact. "
            "Use interdigital_coverage to verify between-finger cleaning. "
            "Use hand_height to verify hands remain above elbows."
        )
    },
    "safe_lifting": {
        "url":   "https://www.osha.gov/etools/electrical-contractors/materials-handling/heavy",
        "emoji": "🏋️",
        "tag":   "Industrial Safety",

        "measurement_hint": (
            "Use shoulder_hip_angle to verify neutral spine alignment. "
            "Use hip_knee_ankle_angle to verify knee bend during lift. "
            "Use wrist_to_body_center to verify load is close to body. "
            "Use body_lean to detect excessive forward bending."
        )
    }
}

# =========================================================================
# 4. بناء الـ prompt
# =========================================================================
def build_prompt(text: str, skill_id: str, source_url: str) -> str:
    meta = STATIC_PROTOCOLS[skill_id]

    return f"""
You are a Clinical Biomechanics AI expert specializing in real-time pose assessment.

=== MISSION ===
Analyze the official medical/safety text below and extract a structured assessment protocol
for "{meta['tag']}". This protocol drives a webcam-based training system using
MediaPipe Pose (33 landmarks) and Hands (21 landmarks per hand).

=== SKILL CONTEXT ===
Skill ID:          {skill_id}
Skill Category:    {meta['tag']}
Source URL:        {source_url}

=== MEASUREMENT APPROACH ===
Use these signal selection hints based on the clinical requirements of this skill:
{meta['measurement_hint']}

=== AVAILABLE TRACKING SIGNALS ===
{build_signal_rule()}

=== EXTRACTION RULES ===

RULE 1 — Signal Selection (defined above):
  - Choose signals PHYSICALLY RELEVANT to "{meta['tag']}".
  - Each dimension must use a DIFFERENT pose_signal.
  - Generate exactly 3–5 dimensions.

RULE 2 — Number Extraction:
  For EVERY numeric value set number_source to:
  - "extracted_from_text"         → number appears explicitly in the source text.
  - "standard_clinical_guideline" → number from medical knowledge (text did not specify).


RULE 3 — Primary Metric:
  Extract the main measurable performance indicator (rate, duration, count, etc.).
  target_min MUST be strictly less than target_max.
  If the source text gives a single value, extract a clinically acceptable range around it.
  Never set target_min equal to target_max.
  
RULE 4 — Feedback (max 8 words each):
  good_feedback  → what to maintain when correct.
  warn_feedback  → what to slightly adjust.
  bad_feedback   → what is critically wrong.

RULE 5 — Output ONLY valid JSON. No markdown, no explanation, no extra text.

RULE 6 — Session Duration:
  Set session_duration_seconds between 30 and 120 seconds
  based on skill complexity.
  
  RULE 7 — Dimension Weight:
  Assign weight 1-3 to each dimension:
  - 1 = standard technique requirement
  - 2 = important for effectiveness  
  - 3 = critical safety requirement (e.g. hand position in CPR, knee bend in lifting)

=== REQUIRED JSON STRUCTURE ===
{{
    "name": "Full official clinical skill name",
    "primary_metric": {{
        "label":          "e.g. Compression Rate",
        "unit":           "e.g. BPM",
        "target_min":     <number>,
        "target_max":     <number>,
        "target_display": "e.g. 100-120 BPM",
        "number_source":  "extracted_from_text OR standard_clinical_guideline"
    }},
    "session_duration_seconds": <number>,
    "dimensions": [
        {{
            "id":            "unique_snake_case_id",
            "name":          "Short display name (2-3 words)",
            "pose_signal":   "MUST match one of the AVAILABLE TRACKING SIGNALS above",
            "perfect_min":   <number>,
            "perfect_max":   <number>,
            "number_source": "extracted_from_text OR standard_clinical_guideline",
            "good_feedback": "Positive, max 8 words",
            "warn_feedback": "Corrective, max 8 words",
            "bad_feedback":  "Critical, max 8 words",
            "weight":        <integer 1-3, where 1=standard, 2=important, 3=critical safety>
        }}
    ],
    "improvement_tips": [
        "Specific actionable tip from the source text",
        "Specific actionable tip from the source text",
        "Specific actionable tip from the source text"
    ]
}}

=== OFFICIAL MEDICAL TEXT TO ANALYZE ===
{text}
"""

# =========================================================================
# 5. إدارة قاعدة البيانات
# =========================================================================
def load_database() -> dict:
    global _db_cache, _db_cache_valid
    if _db_cache_valid:
        return _db_cache
    try:
        response = supabase.table("skills").select(
            "id, name, emoji, tag, session_duration, primary_metric, dimensions, improvement_tips, source"
        ).execute()
        _db_cache = {row["id"]: row for row in response.data}
        _db_cache_valid = True
        return _db_cache
    except Exception as e:
        print(f"❌ فشل جلب البيانات من Supabase: {e}")
        return {}
    
def save_to_database(skill_id: str, skill_config: dict):
    global _db_cache_valid
    _db_cache_valid = False
    try:
        supabase.table("skills").upsert([skill_config]).execute()
        print(f"💾 تم حفظ [{skill_id}] في Supabase")
    except Exception as e:
        print(f"❌ فشل حفظ المهارة: {e}")

# =========================================================================
# 6. الكشط
# =========================================================================
async def scrape(url: str) -> str:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
    except httpx.RequestError as e:
        raise Exception(f"فشل الاتصال: {e}")

    # محاولة trafilatura أولاً — يسحب النص الطبي الفعلي فقط
    extracted = trafilatura.extract(r.text, include_tables=False, no_fallback=False)
    if extracted and len(extracted) > 500:
        return extracted[:15000]

    # fallback — BeautifulSoup
    soup = BeautifulSoup(r.text, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "form"]):
        tag.decompose()
    return soup.get_text(separator=" ", strip=True)[:15000]
# =========================================================================
# 7. استخراج البيانات بـ Gemini
# =========================================================================
def extract_with_gemini(text: str, skill_id: str, source_url: str) -> dict:
    prompt = build_prompt(text, skill_id, source_url)
    last_error = None
    for attempt in range(1, 4):
        try:
            response = client.models.generate_content(
                model="gemini-2.0-flash",
                contents=prompt,
                config=genai.types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.05
                )
            )
            return json.loads(response.text)
        except json.JSONDecodeError as e:
            last_error = f"محاولة {attempt}: JSON غير صالح — {e}"
            print(f"⚠ {last_error}")
        except Exception as e:
            raise Exception(f"فشل Gemini: {e}")
    raise Exception(f"فشل Gemini بعد 3 محاولات — {last_error}")

# =========================================================================
# 8. التحقق من البيانات وبناء الكائن النهائي
# =========================================================================
def validate_and_build(raw: dict, skill_id: str) -> dict:
    meta = STATIC_PROTOCOLS[skill_id]

    # تحقق من primary_metric
    pm = raw.get("primary_metric")
    if not pm:
        raise ValueError("primary_metric مفقود")
    if pm.get("target_min") is None or pm.get("target_max") is None:
        raise ValueError("primary_metric يفتقد target_min أو target_max")
    if pm["target_min"] >= pm["target_max"]:
        raise ValueError(f"target_min ({pm['target_min']}) >= target_max ({pm['target_max']})")

    # تصفية الـ dimensions
    valid_dims = []
    seen_signals = set()
    for i, dim in enumerate(raw.get("dimensions", [])):

        signal = dim.get("pose_signal", "")
        if signal not in VALID_SIGNALS:
            print(f"⚠ تجاهل dimension {i} — signal غير صالح: '{signal}'")
            continue
        if signal in seen_signals:
          print(f"⚠️ تجاهل dimension {i} - تكرر signal '{signal}'")
          continue

        seen_signals.add(signal)
        mn = dim.get("perfect_min")
        mx = dim.get("perfect_max")
        if mn is None or mx is None:
            print(f"⚠ تجاهل dimension {i} — min/max مفقودة")
            continue
        if mn >= mx:
            print(f"⚠ تجاهل dimension {i} — min >= max")
            continue

        s_min, s_max = SIGNAL_SANITY[signal]
        if not (s_min <= mn <= s_max) or not (s_min <= mx <= s_max):
            print(f"⚠ تجاهل dimension {i} — قيم خارج النطاق لـ {signal}: {mn}–{mx}")
            continue

        dim.setdefault("name",          dim.get("id", f"dim_{i}").replace("_", " ").title())
        dim.setdefault("good_feedback", "Good technique — maintain this")
        dim.setdefault("warn_feedback", "Adjust your technique slightly")
        dim.setdefault("bad_feedback",  "Incorrect — review the guidelines")
        dim.setdefault("number_source", "standard_clinical_guideline")
        dim["weight"] = max(1, min(3, int(dim.get("weight", 1))))
        valid_dims.append(dim)

    if not valid_dims:
        raise ValueError("لا يوجد أي dimension صالح بعد التحقق")



    return {
        "id":    skill_id,
        "name":  raw.get("name", skill_id),
        "emoji": meta["emoji"],
        "tag":   meta["tag"],
        "source": {
            "label": raw.get("name", skill_id),
            "url":   meta["url"]
        },
"session_duration": raw.get("session_duration_seconds", 30),
        "primary_metric":   pm,
        "dimensions":       valid_dims,
        "improvement_tips": raw.get("improvement_tips", [
            "Review the official guidelines before each session.",
            "Practice slowly then increase speed gradually.",
            "Focus on maintaining correct posture throughout."
        ])
    }

# =========================================================================
# 9. API Endpoints
# =========================================================================

@app.get("/api/skills/all")
async def get_all_cached():
    db = load_database()
    return db if db else {}


@app.get("/api/skills")
async def get_skills():
    db = load_database()
    return [
        {
            "id":     skill_id,
            "emoji":  meta["emoji"],
            "tag":    meta["tag"],
            "cached": skill_id in db
        }
        for skill_id, meta in STATIC_PROTOCOLS.items()
    ]


@app.get("/api/skills/load/{skill_id}")
async def load_skill(skill_id: str):
    if skill_id not in STATIC_PROTOCOLS:
        raise HTTPException(
            status_code=404,
            detail=f"'{skill_id}' غير مدعوم. المتاح: {list(STATIC_PROTOCOLS.keys())}"
        )

    db = load_database()
    if skill_id in db:
        print(f"⚡ من Supabase: {skill_id}")
        return db[skill_id]

    url = STATIC_PROTOCOLS[skill_id]["url"]
    try:
        print(f"🌍 كشط: {url}")
        text = await scrape(url)
        print(f"🧠 Gemini يحلل {skill_id}...")
        raw = extract_with_gemini(text, skill_id, url)

        print("✅ تحقق من البيانات...")
        final = validate_and_build(raw, skill_id)

        save_to_database(skill_id, final)
        print(f"✓ {skill_id} جاهز — {len(final['dimensions'])} dimensions")
        print(f"  primary_metric source: {final['primary_metric'].get('number_source')}")

        return final

    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/skills/cache/{skill_id}")
async def clear_cache(skill_id: str, x_api_key: str = Header(None)):
    if not API_SECRET or x_api_key != API_SECRET:
        raise HTTPException(status_code=401, detail="غير مصرح")
    try:
        response = supabase.table("skills").delete().eq("id", skill_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="المهارة غير موجودة")
        return {"message": f"تم حذف '{skill_id}' — ستُعاد معالجتها في الطلب التالي"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"فشل الحذف: {e}")
    

@app.get("/api/health")
async def health():
    db = load_database()
    return {
        "status":    "ok",
        "available": list(STATIC_PROTOCOLS.keys()),
        "cached":    list(db.keys()),
        "pending":   [s for s in STATIC_PROTOCOLS if s not in db]
    }


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
