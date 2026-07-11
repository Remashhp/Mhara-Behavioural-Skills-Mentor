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
# 1. Configuration
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
    "http://localhost:5500",      # VS Code Live Server
    "http://127.0.0.1:5500",      # localhost
    "ttps://mhara-behavioural-skills-mentor.netlify.app"# Domain
],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================================================================
# 2. Valid Values — Must Match session.js and camera.js
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

# Logical Ranges — Reject Implausible Gemini Values
SIGNAL_SANITY = {
    "wrist_center_x":          (0.0,  1.0),
    "wrist_center_y":          (0.0,  1.0),
    "arm_angle":               (90,   180),
    "elbow_angle":             (60,   180),
    "body_lean":               (0,    60),
    "shoulder_level":          (0.0,  0.5),
    "hand_height":             (0.0,  0.80),
    "wrist_to_navel_distance": (0.0,  1.0),
    "shoulder_hip_angle":      (90,   180),
    "hip_knee_ankle_angle":    (60,   180),
    "wrist_to_body_center":    (0.0,  1.0),
    "knee_angle":              (60,   180),
    "finger_spread":           (0.0,  0.30),
    "interdigital_coverage":   (0.0,  0.25),
    "palm_to_palm_contact":    (0.0,  0.60),
    "wrist_rotation":          (0,    180),
    "thumb_coverage":          (0.0,  0.40),
    "fist_formation":          (0.0,  0.30),
    "thumb_position":          (0.0,  0.30),
}

# Signal Descriptions — Automatically Included in the Prompt
SIGNAL_DESCRIPTIONS = {
    "wrist_center_x":          "horizontal hand position (0.0–1.0, center=0.5)",
    "wrist_center_y":          "vertical hand position (0.0–1.0, use amplitude for depth)",
    "arm_angle":               "elbow extension in degrees (170–180° = straight)",
    "elbow_angle":             "elbow bend in degrees (90° = perpendicular)",
    "body_lean":               "torso lean in degrees (10–20° = upright)",
    "shoulder_level":          "shoulder height difference (0.0 = level)",
"hand_height":             "SIGNED elbow-minus-wrist height, normalized units. POSITIVE = hands above elbows (typical 0.05-0.40), negative = hands below elbows",    "wrist_to_navel_distance": "wrist distance from navel (0.0–1.0)",
    "shoulder_hip_angle":      "shoulder to hip angle in degrees (180° = upright)",
    "hip_knee_ankle_angle":    "hip to knee to ankle angle in degrees (180° = straight leg)",
    "wrist_to_body_center":    "wrist distance from body center (0.0–1.0)",
    "knee_angle":              "knee bend angle in degrees (90° = full squat)",
   "finger_spread":           "avg distance between adjacent fingertips of ONE hand, normalized units. Realistic values 0.02-0.15. Larger = fingers more spread",
    "interdigital_coverage":   "avg distance between finger base knuckles of ONE hand, normalized units. Realistic values 0.02-0.12. Larger = hand more open",
    "palm_to_palm_contact":    "DISTANCE between the two wrists, normalized units. SMALLER = closer contact. Touching hands = 0.00-0.12. Do NOT treat as a 0-1 quality score",
    "wrist_rotation":          "instantaneous hand tilt angle in degrees, range 0-180 only",
    "thumb_coverage":          "distance thumb-tip to pinky-tip of ONE hand, normalized units. Realistic 0.05-0.25",
    "fist_formation":          "avg fingertip-to-knuckle distance, normalized units. SMALLER = tighter fist. Closed fist = 0.02-0.06, open hand = 0.10-0.20",
    "thumb_position":          "distance thumb-tip to index-tip, normalized units. Realistic 0.01-0.15"
}

def build_signal_rule() -> str:
    lines = [f"RULE 1 — pose_signal MUST be EXACTLY one of these {len(VALID_SIGNALS)} values:"]
    for signal in sorted(VALID_SIGNALS):
        desc = SIGNAL_DESCRIPTIONS.get(signal, "")
        lines.append(f"  - {signal:<30} → {desc}")
    return "\n".join(lines)

# =========================================================================
# 3. Skills Catalog
# =========================================================================
STATIC_PROTOCOLS = {
    "cpr": {
        "name": "CPR / Chest Compressions",
        "domain": "medical",
        "url":   "https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines",
        "emoji": "🫀",
        "tag":   "Basic Life Support",
       "measurement_hint": (
  
    # Compression depth
    "Use wrist_center_y to measure compression depth via amplitude detection. "
    "The perfect_max represents the minimum required wrist movement amplitude "
    "that corresponds to AHA guideline of minimum 2 inches (5cm) compression depth. "

    # Arm straightness
    "Use elbow_angle as a POSTURE criterion: arms must stay straight "
    "with elbows locked throughout compressions (per CPR guidelines). "
    "Set perfect_min and perfect_max to the acceptable straight-arm "
    "range in degrees (typically ~160-180). "

    # Hand position
    "Use wrist_center_x for hand centering on sternum. "
    "Set perfect_min and perfect_max to represent the center of the chest "
    "based on AHA guideline: hands at center of sternum. "

   "IMPORTANT: You MUST include ALL 4 dimensions — missing any one is an error. "
"Include them in this exact order: "
"wrist_center_y, elbow_angle, wrist_center_x, palm_to_palm_contact. "
"wrist_center_y is MANDATORY — it is the ONLY way to detect compression depth and rhythm. "
"Without wrist_center_y the system cannot count compressions or measure depth. "
"palm_to_palm_contact detects hand stacking — SMALLER value = hands stacked correctly. "
"Set palm_to_palm_contact perfect_max to the maximum wrist distance for correct stacking."
),  

    },
    "heimlich": {
        "name": "Heimlich Maneuver",
        "domain": "medical",
        "url":   "https://my.clevelandclinic.org/health/treatments/21675-heimlich-maneuver",
        "emoji": "🤲",
        "tag":   "Emergency Response",
        "measurement_hint": (
            "Use wrist_center_y as the FIRST dimension to detect thrust motion "
            "via amplitude: perfect_max represents the minimum wrist movement "
            "amplitude for an effective inward-upward thrust (a value around "
            "0.05-0.08 in normalized units). perfect_min can be a small value "
            "below it. This drives thrust counting and rhythm. "
            "Use wrist_center_x for hands centered on the patient midline "
            "(0.45-0.55). "
            "Use elbow_angle for correct arm wrap around the abdomen (80-110). "
            "Use shoulder_hip_angle for upright rescuer stance behind patient. "
            "For primary_metric: thrust rate per minute is the measurable "
            "indicator — a deliberate thrust roughly every 1-2 seconds gives "
            "target_min around 30 and target_max around 60 thrusts/min, "
            "unit 'TPM'. "
            "Do NOT use body_lean — forward lean is invisible from this "
            "camera setup. "
            "In improvement_tips, the FIRST tip must state: 'This assessment "
            "evaluates rescuer positioning and thrust motion only — actual "
            "hand placement on a patient requires a training manikin or partner.' "
        )
    },
    "hand_hygiene": {
        "name": "Hand Hygiene (WHO Technique)",
        "domain": "medical",
        "url": "https://www.cdc.gov/clean-hands/about/index.html",
        "emoji": "🧼",
        "tag":   "Aseptic Technique",
        "measurement_hint": (
            "IMPORTANT: all hand signals are RAW normalized distances — use the "
            "realistic ranges stated in each signal description, NOT 0-1 quality scores. "
            "Use palm_to_palm_contact for bilateral contact: touching hands means a SMALL "
            "distance, so set perfect_min near 0.0 and perfect_max around 0.10-0.15. "
            "Use interdigital_coverage (realistic 0.02-0.12) for between-finger cleaning. "
            "Use finger_spread (realistic 0.02-0.15) for finger separation. "
            "Use wrist_rotation (0-180 degrees, wide range like 40-170) for scrubbing motion. "
            "Use hand_height for hands-above-elbows: positive = hands above elbows; "
            "set perfect_min around 0.02 and perfect_max around 0.50."
        )
    },
    "safe_lifting": {
        "name": "Safe Manual Lifting",
        "domain": "industrial",
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
# 4. prompt
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
  Set session_duration_seconds based on the official source text.
  If the source text specifies a duration or cycle time, use it.
  If not, use clinical reasoning based on how long one complete 
  correct repetition of this skill realistically takes.
  Range must be between 10 and 120 seconds.
  Never default to 30 unless clinically justified.
  
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
# 5. Database Management
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
# 6. Web Scraping
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

    # Try trafilatura first — extracts the actual medical text only
    extracted = trafilatura.extract(r.text, include_tables=False, no_fallback=False)
    if extracted and len(extracted) > 500:
        return extracted[:15000]

    # fallback — BeautifulSoup
    soup = BeautifulSoup(r.text, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "form"]):
        tag.decompose()
    return soup.get_text(separator=" ", strip=True)[:15000]

# =========================================================================
# 7. Gemini Data Extraction
# =========================================================================

def extract_with_gemini(text: str, skill_id: str, source_url: str) -> dict:
    prompt = build_prompt(text, skill_id, source_url)
    last_error = None
    for attempt in range(1, 4):
        try:
            response = client.models.generate_content(
                #model="gemini-3.5-flash",
               # model="gemini-2.0-flash",
               model="gemini-2.5-flash-lite",

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
# 8. Data Validation and Final Object Construction
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
    
    #Check session duration — aligns with RULE 6: No silent default
    duration = raw.get("session_duration_seconds")
    if duration is None:
        raise ValueError("session_duration_seconds missing from extraction")
    if not (10 <= duration <= 120):
        raise ValueError(f"session_duration_seconds out of allowed range (10-120): {duration}")
    
    # Filter dimensions
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
"session_duration": duration,
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
            "name":   meta["name"],
            "emoji":  meta["emoji"],
            "tag":    meta["tag"],
            "domain": meta["domain"],
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
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)  
