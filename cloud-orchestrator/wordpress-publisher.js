import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveGeminiApiKey } from "./gemini-concierge.js";

const GENERATED_TMP_DIR = "/tmp/mission-generated";
const CLERGY_OR_SPEAKER_TITLE_RE =
  /\b(Bishop|Pastor|Apostle|Elder|First\s+Lady|Lady|Evangelist|Rev\.?|Dr\.?|Minister|Min\.?|Missionary|Mother|Deacon|Overseer|Speaker|Preacher|Psalmist)\b/i;

export function ensureGeneratedDir() {
  if (!fs.existsSync(GENERATED_TMP_DIR)) {
    fs.mkdirSync(GENERATED_TMP_DIR, { recursive: true });
  }
  return GENERATED_TMP_DIR;
}

export function getGeneratedMediaFile(filename) {
  const safeName = path.basename(String(filename || ""));
  if (!safeName) return null;
  const fullPath = path.join(ensureGeneratedDir(), safeName);
  return fs.existsSync(fullPath) ? fullPath : null;
}

export function getWordPressConfig() {
  const approvalSecret =
    process.env.APPROVAL_HMAC_SECRET ||
    process.env.MISSION_APPROVAL_SECRET ||
    "";
  return {
    baseUrl: (process.env.WP_BASE_URL || "https://missionchurchcooljc.com").replace(/\/+$/, ""),
    username: (process.env.WP_USERNAME || "brother kevin").trim(),
    appPassword: (process.env.MISSION_WP_APP_PASSWORD || process.env.WP_APP_PASSWORD || "").trim(),
    approvalSecret: String(approvalSecret).trim(),
  };
}

export function isWordPressConfigured() {
  const cfg = getWordPressConfig();
  return Boolean(cfg.baseUrl && (cfg.approvalSecret || (cfg.username && cfg.appPassword)));
}

function getWpAuthHeader() {
  const { username, appPassword } = getWordPressConfig();
  const cleanPass = appPassword.replace(/\s+/g, " ");
  return `Basic ${Buffer.from(`${username}:${cleanPass}`).toString("base64")}`;
}

/**
 * Resolves whether a parsed item targets WordPress Posts only or both Posts + M.E. Calendar Events.
 * Routine recurring weekly events are filtered earlier in triage.
 */
export function resolveTargetTypesForDraft(item = {}) {
  if (Array.isArray(item.targetTypes) && item.targetTypes.length) {
    return item.targetTypes;
  }
  if (item.contentType === "announcement_post") {
    return ["post"];
  }
  return ["post", "mec-events"];
}

/**
 * Strips regular lay participant names & personal contacts from public copy,
 * while preserving clergy titles and designated speakers.
 */
export function sanitizePublicCopy(text, { preserveSpeakers = [] } = {}) {
  let out = String(text || "").trim();
  if (!out) return "";

  const preserveSet = new Set(preserveSpeakers.map((s) => String(s).trim().toLowerCase()).filter(Boolean));

  // Redact personal email addresses other than official church email
  out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (email) =>
    email.toLowerCase() === "missionchurch1@gmail.com" ? email : "missionchurch1@gmail.com"
  );

  // Replace casual "see Bro. X / Sis. Y" or "contact Brother X / Sister Y" phrases unless clergy/speaker
  out = out.replace(
    /\b(?:contact|see|email|call|reach\s+out\s+to)\s+((?:Brother|Bro\.?|Sister|Sis\.?|Deaconess|Mrs?\.?|Ms\.?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g,
    (full, person) => {
      if (preserveSet.has(person.toLowerCase()) || /\bLady\s+Carla\s+Mitchell\b/i.test(person)) {
        return full;
      }
      return "contact the church office (617-863-6614)";
    }
  );

  // Strip standalone lay Bro./Sis. participant names unless explicitly listed as speaker
  out = out.replace(/\b((?:Brother|Bro\.?|Sister|Sis\.?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g, (person) => {
    if (preserveSet.has(person.toLowerCase()) || CLERGY_OR_SPEAKER_TITLE_RE.test(person)) {
      return person;
    }
    return "our ministry team";
  });

  return out.replace(/\s{2,}/g, " ").trim();
}

export function buildGutenbergPostHtml({
  summary,
  dateDisplay,
  location,
  speaker,
  zoomUrl,
  extraNotes = [],
}) {
  const escHtml = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const blocks = [];
  if (summary) {
    blocks.push(`<!-- wp:paragraph -->\n<p>${escHtml(summary)}</p>\n<!-- /wp:paragraph -->`);
  }

  const metaBullets = [];
  if (dateDisplay) metaBullets.push(`<strong>When:</strong> ${escHtml(dateDisplay)}`);
  if (location) metaBullets.push(`<strong>Location:</strong> ${escHtml(location)}`);
  if (speaker) metaBullets.push(`<strong>Speaker / Leadership:</strong> ${escHtml(speaker)}`);
  for (const n of extraNotes) {
    if (n) metaBullets.push(escHtml(n));
  }

  if (metaBullets.length) {
    blocks.push(
      `<!-- wp:list -->\n<ul>${metaBullets.map((li) => `<li>${li}</li>`).join("")}</ul>\n<!-- /wp:list -->`
    );
  }

  if (zoomUrl) {
    blocks.push(
      `<!-- wp:paragraph -->\n<p><a href="${escHtml(zoomUrl)}" target="_blank" rel="noopener noreferrer">Join Virtual Gathering on Zoom ↗</a></p>\n<!-- /wp:paragraph -->`
    );
  }

  return blocks.join("\n\n");
}

function buildFallbackBrandedSvg({ title, dateDisplay, location, badge = "MISSION CHURCH COOLJC" }) {
  const escXml = (s) =>
    String(s ?? "")
      .slice(0, 90)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const safeTitle = escXml(title);
  const words = safeTitle.split(/\s+/);
  const line1 = words.slice(0, Math.ceil(words.length / 2)).join(" ");
  const line2 = words.slice(Math.ceil(words.length / 2)).join(" ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" width="1200" height="675">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#4a0d13" />
      <stop offset="55%" stop-color="#7e151c" />
      <stop offset="100%" stop-color="#1e1720" />
    </linearGradient>
    <linearGradient id="goldBar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ecd363" />
      <stop offset="100%" stop-color="#d4af37" />
    </linearGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#bg)" />
  <rect x="44" y="44" width="1112" height="587" rx="28" fill="#ffffff" />
  <rect x="44" y="44" width="1112" height="16" rx="8" fill="url(#goldBar)" />
  <rect x="88" y="96" width="290" height="38" rx="19" fill="#f7f7f9" stroke="#7e151c" stroke-width="1.5" />
  <text x="233" y="121" text-anchor="middle" font-family="Plus Jakarta Sans, Arial, sans-serif" font-size="14" font-weight="800" letter-spacing="2" fill="#7e151c">${escXml(badge)}</text>
  <text x="88" y="235" font-family="Georgia, serif" font-size="56" font-weight="700" fill="#1e1720">${line1}</text>
  <text x="88" y="305" font-family="Georgia, serif" font-size="56" font-weight="700" fill="#7e151c">${line2}</text>
  <line x1="88" y1="356" x2="480" y2="356" stroke="#d4af37" stroke-width="4" />
  <text x="88" y="420" font-family="Plus Jakarta Sans, Arial, sans-serif" font-size="28" font-weight="700" fill="#4a0d13">${escXml(dateDisplay)}</text>
  <text x="88" y="468" font-family="Plus Jakarta Sans, Arial, sans-serif" font-size="22" font-weight="500" fill="#5d525f">${escXml(location)}</text>
  <rect x="88" y="528" width="1024" height="64" rx="14" fill="#f7f7f9" />
  <text x="116" y="567" font-family="Plus Jakarta Sans, Arial, sans-serif" font-size="20" font-weight="700" fill="#1e1720">Mission Church Of Our Lord Jesus Christ · 130 Highland Ave, Somerville, MA</text>
</svg>`;
}

/**
 * Generates Option B (AI / Blended Image) while retaining Option A (Original Image).
 */
export async function prepareDualEventImages({
  draftId,
  title,
  dateDisplay,
  location,
  badge,
  originalImageUrl,
  originalImageBase64 = "",
  originalImageMimeType = "image/jpeg",
  publicBaseUrl,
}) {
  const apiKey = resolveGeminiApiKey();
  const safeId = String(draftId || crypto.randomUUID().slice(0, 8)).replace(/[^a-zA-Z0-9_-]/g, "");
  ensureGeneratedDir();

  // Attempt Gemini native image generation / blended re-styling first
  if (apiKey) {
    const prompt = originalImageBase64
      ? `Create a clean, modern, bright white-and-burgundy church event graphic inspired by the attached church flyer. Feature crisp visual atmosphere for "${title}" (${dateDisplay}) at Mission Church in Somerville, MA. Use editorial white space, burgundy (#7E151C), and warm gold (#D4AF37) accents. Do NOT include messy tiny paragraphs or unrelated names.`
      : `Create a clean, bright, editorial white-and-burgundy church event graphic for "${title}" (${dateDisplay}) at Mission Church of Our Lord Jesus Christ, Somerville MA. Subtle cross, warm light, burgundy (#7E151C) and gold (#D4AF37) accents, high clarity, welcoming atmosphere.`;

    const parts = [{ text: prompt }];
    if (originalImageBase64) {
      parts.push({ inlineData: { mimeType: originalImageMimeType, data: originalImageBase64 } });
    }

    const imageModels = ["gemini-2.0-flash-exp-image-generation", "gemini-2.5-flash-image"];
    for (const model of imageModels) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 18000);
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"],
            },
          }),
        });
        clearTimeout(timer);
        if (!res.ok) continue;
        const json = await res.json();
        const candParts = json?.candidates?.[0]?.content?.parts || [];
        const imgPart = candParts.find((p) => p.inlineData?.data);
        if (imgPart?.inlineData?.data) {
          const ext = imgPart.inlineData.mimeType === "image/jpeg" ? "jpg" : "png";
          const fileName = `${safeId}-ai.${ext}`;
          fs.writeFileSync(path.join(GENERATED_TMP_DIR, fileName), Buffer.from(imgPart.inlineData.data, "base64"));
          const aiPath = `/api/media/generated/${fileName}`;
          return {
            originalImageUrl,
            aiImageUrl: aiPath,
            aiAbsoluteUrl: `${publicBaseUrl}${aiPath}`,
            aiGenerator: `gemini:${model}`,
          };
        }
      } catch {
        // Fall through to SVG card graphic
      }
    }
  }

  // Deterministic branded banner fallback so Option B always renders crisply
  const svgFile = `${safeId}-ai.svg`;
  const svg = buildFallbackBrandedSvg({ title, dateDisplay, location, badge });
  fs.writeFileSync(path.join(GENERATED_TMP_DIR, svgFile), svg, "utf8");
  const aiPath = `/api/media/generated/${svgFile}`;
  return {
    originalImageUrl,
    aiImageUrl: aiPath,
    aiAbsoluteUrl: `${publicBaseUrl}${aiPath}`,
    aiGenerator: "branded-svg-composer",
  };
}

/**
 * Parses either a monthly church calendar or individual event email into sanitized
 * net-new WordPress posts + MEC events (excluding routine recurring weekly clutter unless highlighted).
 */
export async function parseMonthlyCalendarOrEmail({
  subject = "",
  bodyText = "",
  imageBase64 = "",
  imageMimeType = "image/jpeg",
}) {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    return {
      isMonthlyCalendar: /calendar/i.test(subject),
      monthLabel: "",
      recurringSummary: ["Sunday Worship (12:00 PM)", "Tuesday Bible Study (7:30 PM)", "Morning Prayer"],
      netNewEvents: [
        {
          title: sanitizePublicCopy(subject || "Mission Church Update").slice(0, 70),
          category: "Upcoming Events",
          startDate: new Date().toISOString().slice(0, 10),
          startTime: "12:00",
          endTime: "14:00",
          location: "130 Highland Ave, Somerville, MA",
          speaker: "",
          publicSummary: sanitizePublicCopy(bodyText || subject).slice(0, 260),
        },
      ],
    };
  }

  const prompt = `You are a church communications editor for Mission Church of Our Lord Jesus Christ (130 Highland Ave, Somerville, MA).
Inspect the email text and/or attached flyer or Monthly Church Calendar image.

RULES:
1. Detect whether this email is a Monthly Church Calendar ("isMonthlyCalendar": true) or a single event/announcement ("isMonthlyCalendar": false).
2. Classify each item with "contentType" and "isRecurring":
   - "recurring_event" ("isRecurring": true): Routine recurring weekly schedule already on M.E. Calendar (regular Sunday Worship at 12 PM, regular Monday 6:30 AM Prayer, regular Tue–Thu 7:00 AM Prayer Line, regular Tuesday 7:30 PM Bible Study). Put these in "recurringSummary" and omit from "netNewEvents".
   - "special_event" ("isRecurring": false): Dated net-new event or special gathering (1st Sunday Communion, 5th Sunday Fellowship, Shepherd's Kitchen, guest speakers like Elder Joseph C. Black Jr., Youth Service, Candlelight Service, Watch Night, conferences, concerts) -> creates BOTH a WordPress Post and M.E. Calendar Event.
   - "announcement_post" ("isRecurring": false): General non-event church update (Building Fund pledge, BAND App invite, pastoral letter, ministry news without a dated calendar slot) -> creates ONLY a WordPress Post (no M.E. Calendar Event).
   - Always omit private internal-only meetings (Staff/Trustees/Deacon meetings) unless explicitly emphasized for the congregation. If "isMonthlyCalendar" is false and it is not routine recurring weekly clutter, include at least 1 item in "netNewEvents".
3. PRIVACY & SPEAKER RULE: In "publicSummary" and "title", STRIP regular church participant / lay member names (e.g., Sister X, Brother Y organizing snacks/logistics) while KEEPING clergy members and billed speakers (Bishop, Pastor, Apostle, Elder, First Lady, Evangelist, Minister, featured guest speakers).
4. Return ONLY valid JSON (no markdown fences):
{
  "isMonthlyCalendar": boolean,
  "monthLabel": "e.g. December 2026 or empty",
  "recurringSummary": ["short strings"],
  "netNewEvents": [
    {
      "title": "clean public title (max 70 chars)",
      "contentType": "special_event | announcement_post | recurring_event",
      "isRecurring": boolean,
      "category": "one of: Upcoming Events, Outreach & Pantry, Youth & Fellowship, Zoom Gatherings, Stewardship & News",
      "badge": "uppercase pill e.g. 5TH SUNDAY · NOV 29 or CHURCH NEWS",
      "startDate": "YYYY-MM-DD (empty if announcement_post with no event date)",
      "startTime": "HH:MM (24h)",
      "endDate": "YYYY-MM-DD",
      "endTime": "HH:MM (24h)",
      "dateDisplay": "human-readable date & time",
      "location": "130 Highland Ave, Somerville, MA or Virtual on Zoom",
      "speaker": "clergy or platform speaker names if any, else empty",
      "zoomUrl": "zoom URL if explicitly present, else empty",
      "publicSummary": "2-sentence welcoming public summary with lay member names stripped and clergy/speakers preserved"
    }
  ]
}

EMAIL SUBJECT: ${subject}
EMAIL BODY:
${String(bodyText).slice(0, 4500)}`;

  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({ inlineData: { mimeType: imageMimeType, data: imageBase64 } });
  }

  for (const model of [process.env.GEMINI_MODEL || "gemini-2.5-flash", "gemini-2.0-flash"]) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
            ...(model.includes("2.5") ? { thinkingConfig: { thinkingBudget: 512 } } : {}),
          },
        }),
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!raw) continue;
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed.netNewEvents)) {
        const filtered = [];
        parsed.recurringSummary = Array.isArray(parsed.recurringSummary) ? parsed.recurringSummary : [];
        for (const ev of parsed.netNewEvents) {
          if (ev.isRecurring || ev.contentType === "recurring_event") {
            if (ev.title && !parsed.recurringSummary.includes(ev.title)) {
              parsed.recurringSummary.push(`${ev.title} (${ev.dateDisplay || "Recurring"})`);
            }
            continue;
          }
          const contentType = ev.contentType === "announcement_post" ? "announcement_post" : "special_event";
          filtered.push({
            ...ev,
            contentType,
            isRecurring: false,
            targetTypes: resolveTargetTypesForDraft({ contentType, targetTypes: ev.targetTypes }),
            publicSummary: sanitizePublicCopy(ev.publicSummary || "", {
              preserveSpeakers: ev.speaker ? ev.speaker.split(/[,;&]+/) : [],
            }),
          });
        }
        parsed.netNewEvents = filtered;
      }
      return parsed;
    } catch {
      // Try next model
    }
  }

  return {
    isMonthlyCalendar: /calendar/i.test(subject),
    monthLabel: "",
    recurringSummary: [],
    netNewEvents: [],
  };
}

async function resolveImageBuffer(imageUrlOrPath, publicDir) {
  if (!imageUrlOrPath) return null;
  if (imageUrlOrPath.startsWith("/api/media/generated/")) {
    const file = getGeneratedMediaFile(imageUrlOrPath.split("/").pop());
    if (file && fs.existsSync(file)) {
      const ext = path.extname(file).toLowerCase();
      return {
        buffer: fs.readFileSync(file),
        filename: path.basename(file),
        contentType: ext === ".svg" ? "image/svg+xml" : ext === ".png" ? "image/png" : "image/jpeg",
      };
    }
  }
  if (imageUrlOrPath.startsWith("/") && publicDir) {
    const localFile = path.resolve(publicDir, "." + imageUrlOrPath);
    if (localFile.startsWith(publicDir) && fs.existsSync(localFile)) {
      const ext = path.extname(localFile).toLowerCase();
      return {
        buffer: fs.readFileSync(localFile),
        filename: path.basename(localFile),
        contentType: ext === ".svg" ? "image/svg+xml" : ext === ".png" ? "image/png" : "image/jpeg",
      };
    }
  }
  if (imageUrlOrPath.startsWith("https://") || imageUrlOrPath.startsWith("http://")) {
    const res = await fetch(imageUrlOrPath);
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = ct.includes("png") ? "png" : ct.includes("svg") ? "svg" : "jpg";
    return {
      buffer: buf,
      filename: `mission-event-${Date.now()}.${ext}`,
      contentType: ct,
    };
  }
  return null;
}

export async function uploadMediaToWordPress({ imageUrl, publicDir, title }) {
  const { baseUrl } = getWordPressConfig();
  if (!isWordPressConfigured()) throw new Error("WordPress credentials not configured");

  const resolved = await resolveImageBuffer(imageUrl, publicDir);
  if (!resolved) return null;

  const res = await fetch(`${baseUrl}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: getWpAuthHeader(),
      "Content-Type": resolved.contentType,
      "Content-Disposition": `attachment; filename="${resolved.filename}"`,
    },
    body: resolved.buffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WP media upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const media = await res.json();
  if (media.id && title) {
    await fetch(`${baseUrl}/wp-json/wp/v2/media/${media.id}`, {
      method: "POST",
      headers: {
        Authorization: getWpAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, alt_text: title }),
    }).catch(() => {});
  }
  return media;
}

export async function publishDraftToWordPress({
  draft,
  imageChoice = "original",
  wpStatus = "draft",
  targetTypes,
  publicDir,
}) {
  const effectiveTargetTypes =
    Array.isArray(targetTypes) && targetTypes.length ? targetTypes : resolveTargetTypesForDraft(draft);
  const { baseUrl, approvalSecret, appPassword } = getWordPressConfig();
  if (!isWordPressConfigured()) {
    throw new Error("WordPress credentials or signing secret are not configured.");
  }

  const chosenImageUrl =
    imageChoice === "ai" && draft.aiImageUrl ? draft.aiImageUrl : draft.imageUrl;

  const cleanSummary = sanitizePublicCopy(draft.summary, {
    preserveSpeakers: draft.speaker ? draft.speaker.split(/[,;&]+/) : [],
  });

  const gutenbergHtml = buildGutenbergPostHtml({
    summary: cleanSummary,
    dateDisplay: draft.dateDisplay,
    location: draft.location,
    speaker: draft.speaker,
    zoomUrl: draft.zoomUrl,
  });

  // 1. Primary path: signed 1-click Mission Church Cloud Sync endpoint (/wp-json/mission/v1/publish)
  if (approvalSecret) {
    const resolved = await resolveImageBuffer(chosenImageUrl, publicDir).catch(() => null);
    const bodyObj = {
      title: draft.title,
      content: gutenbergHtml,
      excerpt: cleanSummary,
      status: wpStatus,
      createPost: effectiveTargetTypes.includes("post"),
      createMecEvent: effectiveTargetTypes.includes("mec-events"),
      startDate: draft.startDate || new Date().toISOString().slice(0, 10),
      endDate: draft.endDate || draft.startDate || new Date().toISOString().slice(0, 10),
      startTime: draft.startTime || "12:00",
      endTime: draft.endTime || "14:00",
      location: draft.location || "130 Highland Ave, Somerville, MA",
      ...(resolved && !resolved.contentType.includes("svg")
        ? {
            imageBase64: resolved.buffer.toString("base64"),
            imageMimeType: resolved.contentType,
            filename: resolved.filename,
          }
        : chosenImageUrl?.startsWith("http")
        ? { imageUrl: chosenImageUrl }
        : {}),
    };
    const rawBody = JSON.stringify(bodyObj);
    const sig = crypto.createHmac("sha256", approvalSecret).update(rawBody).digest("hex");
    const syncRes = await fetch(`${baseUrl}/wp-json/mission/v1/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mission-Signature": sig,
        "X-Approval-Secret": approvalSecret,
      },
      body: rawBody,
    });
    if (syncRes.ok) {
      return await syncRes.json();
    }
    if (!appPassword) {
      const errTxt = await syncRes.text();
      throw new Error(`Mission Sync REST failed (${syncRes.status}): ${errTxt.slice(0, 220)}`);
    }
  }

  let media = null;
  try {
    media = await uploadMediaToWordPress({
      imageUrl: chosenImageUrl,
      publicDir,
      title: draft.title,
    });
  } catch (err) {
    // Allow continuing cleanly if media upload was SVG/unsupported type on WP side, falling back to original image
    if (imageChoice === "ai" && draft.imageUrl && draft.imageUrl !== chosenImageUrl) {
      media = await uploadMediaToWordPress({
        imageUrl: draft.imageUrl,
        publicDir,
        title: draft.title,
      }).catch(() => null);
    } else {
      throw err;
    }
  }

  const results = { featuredMediaId: media?.id || null, featuredMediaUrl: media?.source_url || null };

  if (effectiveTargetTypes.includes("post")) {
    const postRes = await fetch(`${baseUrl}/wp-json/wp/v2/posts`, {
      method: "POST",
      headers: {
        Authorization: getWpAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: draft.title,
        content: gutenbergHtml,
        excerpt: cleanSummary,
        status: wpStatus,
        ...(media?.id ? { featured_media: media.id } : {}),
      }),
    });
    if (!postRes.ok) {
      throw new Error(`WP post create failed (${postRes.status}): ${(await postRes.text()).slice(0, 200)}`);
    }
    const postJson = await postRes.json();
    results.post = {
      id: postJson.id,
      status: postJson.status,
      link: postJson.link,
      editUrl: `${baseUrl}/wp-admin/post.php?post=${postJson.id}&action=edit`,
    };
  }

  if (effectiveTargetTypes.includes("mec-events")) {
    const eventRes = await fetch(`${baseUrl}/wp-json/wp/v2/mec-events`, {
      method: "POST",
      headers: {
        Authorization: getWpAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: draft.title,
        content: gutenbergHtml,
        excerpt: cleanSummary,
        status: wpStatus,
        ...(media?.id ? { featured_media: media.id } : {}),
      }),
    });
    if (eventRes.ok) {
      const eventJson = await eventRes.json();
      results.event = {
        id: eventJson.id,
        status: eventJson.status,
        link: eventJson.link,
        editUrl: `${baseUrl}/wp-admin/post.php?post=${eventJson.id}&action=edit`,
      };
    } else {
      results.eventError = `MEC REST status ${eventRes.status}`;
    }
  }

  return results;
}

function parse24hTo12h(timeStr = "12:00") {
  const m = String(timeStr || "12:00").match(/(\d{1,2}):(\d{2})/);
  const h24 = m ? Number(m[1]) : 12;
  const min = m ? m[2] : "00";
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { hour: String(h12), minutes: min, ampm };
}

export function buildWpAdminAutoPublishScript({
  draft,
  imageChoice = "original",
  wpStatus = "draft",
  publicBaseUrl,
}) {
  const chosenRelOrAbs =
    imageChoice === "ai" && draft.aiImageUrl ? draft.aiImageUrl : draft.imageUrl;
  const chosenImageUrl = chosenRelOrAbs?.startsWith("http")
    ? chosenRelOrAbs
    : `${publicBaseUrl}${chosenRelOrAbs || "/assets/photos/00_cover_sanctuary_worship_1920x1080.jpg"}`;

  const cleanSummary = sanitizePublicCopy(draft.summary, {
    preserveSpeakers: draft.speaker ? draft.speaker.split(/[,;&]+/) : [],
  });
  const gutenbergHtml = buildGutenbergPostHtml({
    summary: cleanSummary,
    dateDisplay: draft.dateDisplay,
    location: draft.location,
    speaker: draft.speaker,
    zoomUrl: draft.zoomUrl,
  });

  const startDate = draft.startDate || new Date().toISOString().slice(0, 10);
  const endDate = draft.endDate || startDate;
  const st = parse24hTo12h(draft.startTime || "12:00");
  const et = parse24hTo12h(draft.endTime || "14:00");

  const payload = {
    draftId: draft.id,
    title: draft.title,
    cleanSummary,
    gutenbergHtml,
    wpStatus,
    chosenImageUrl,
    startDate,
    endDate,
    startHour: st.hour,
    startMinutes: st.minutes,
    startAmPm: st.ampm,
    endHour: et.hour,
    endMinutes: et.minutes,
    endAmPm: et.ampm,
  };

  return `(async function() {
  const cfg = ${JSON.stringify(payload)};
  const nonce = (window.wpApiSettings && window.wpApiSettings.nonce) || "";
  if (!nonce) throw new Error("Must run inside logged-in missionchurchcooljc.com/wp-admin session with wpApiSettings.nonce.");

  let mediaId = 0;
  try {
    const imgResp = await fetch(cfg.chosenImageUrl);
    if (imgResp.ok) {
      const blob = await imgResp.blob();
      const ext = blob.type.includes("png") ? "png" : blob.type.includes("svg") ? "svg" : "jpg";
      const up = await fetch("/wp-json/wp/v2/media", {
        method: "POST",
        headers: {
          "X-WP-Nonce": nonce,
          "Content-Type": blob.type || "image/jpeg",
          "Content-Disposition": "attachment; filename=mission-" + Date.now() + "." + ext
        },
        body: blob
      });
      if (up.ok) {
        const mj = await up.json();
        mediaId = mj.id || 0;
      }
    }
  } catch (e) {}

  const postResp = await fetch("/wp-json/wp/v2/posts", {
    method: "POST",
    headers: { "X-WP-Nonce": nonce, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: cfg.title,
      content: cfg.gutenbergHtml,
      excerpt: cfg.cleanSummary,
      status: cfg.wpStatus,
      ...(mediaId ? { featured_media: mediaId } : {})
    })
  });
  const postData = await postResp.json();

  const evResp = await fetch("/wp-json/wp/v2/mec-events", {
    method: "POST",
    headers: { "X-WP-Nonce": nonce, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: cfg.title,
      content: cfg.gutenbergHtml,
      excerpt: cfg.cleanSummary,
      status: cfg.wpStatus,
      ...(mediaId ? { featured_media: mediaId } : {})
    })
  });
  const evData = await evResp.json();

  let mecMetaSaved = false;
  if (evData && evData.id) {
    try {
      const editHtml = await (await fetch("/wp-admin/post.php?post=" + evData.id + "&action=edit")).text();
      const doc = new DOMParser().parseFromString(editHtml, "text/html");
      const form = doc.querySelector("form#post");
      if (form) {
        const fd = new FormData(form);
        fd.set("post_status", cfg.wpStatus);
        fd.set("mec[date][start][date]", cfg.startDate);
        fd.set("mec[date][start][hour]", cfg.startHour);
        fd.set("mec[date][start][minutes]", cfg.startMinutes);
        fd.set("mec[date][start][ampm]", cfg.startAmPm);
        fd.set("mec[date][end][date]", cfg.endDate);
        fd.set("mec[date][end][hour]", cfg.endHour);
        fd.set("mec[date][end][minutes]", cfg.endMinutes);
        fd.set("mec[date][end][ampm]", cfg.endAmPm);
        const saveRes = await fetch("/wp-admin/post.php", { method: "POST", body: fd });
        mecMetaSaved = saveRes.ok;
      }
    } catch (e) {}
  }

  const summaryOut = { ok: true, mediaId, post: { id: postData.id, status: postData.status, link: postData.link }, event: { id: evData.id, status: evData.status, mecMetaSaved } };
  window.__missionWpLastResult = summaryOut;
  return summaryOut;
})();`;
}
