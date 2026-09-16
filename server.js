require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.disable("x-powered-by");

// Render (and most hosts) terminate TLS at a proxy in front of the app.
// Without this, req.ip is the proxy's IP, so every visitor shares one
// rate-limit bucket.
app.set("trust proxy", 1);

app.use(express.json({ limit: "10kb" }));

/* --------------------------------------------------------------------------
 * CORS
 * ------------------------------------------------------------------------ */

// Normalize so "https://Site.com/", "https://site.com" and
// "HTTPS://SITE.COM" all compare equal.
const normalizeOrigin = (value) =>
  String(value || "").trim().replace(/\/+$/, "").toLowerCase();

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

const isAllowedOrigin = (origin) => {
  // No Origin header => curl / server-to-server / health checks. Allow it.
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes(normalizeOrigin(origin));
};

app.use(
  cors({
    origin(origin, callback) {
      // IMPORTANT: never call back with an Error here. Doing so makes the
      // cors middleware forward the error to the error handler, which replies
      // *without* CORS headers — the browser then reports a generic
      // "No 'Access-Control-Allow-Origin' header" and hides the real status.
      callback(null, isAllowedOrigin(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    maxAge: 86400,
  })
);

// Explicitly reject disallowed browser origins. We echo the origin back so the
// browser lets the frontend read this 403 + message instead of swallowing it
// as an opaque network error.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    console.warn(`Blocked CORS origin: ${origin}`);
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    return res.status(403).json({ error: "Origin not allowed." });
  }
  next();
});

/* --------------------------------------------------------------------------
 * Rate limiting
 * ------------------------------------------------------------------------ */

const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15, // 15 messages/minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many messages sent — please wait a moment and try again.",
  },
});

/* --------------------------------------------------------------------------
 * Felicity's persona + grounded company facts
 * ------------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You are Felicity, the friendly virtual assistant embedded on DCODE's website. About DCODE: - Services: web development, UI/UX design, mobile app development (iOS & Android), cloud infrastructure & migration, AI/automation solutions, and security. - Contact: dcodedevs@gmail.com, +254-768-372532. Based in Nairobi, Kenya, working with clients remotely worldwide. - Portfolio highlights (visible on the Projects page, filterable by category): E-Commerce Platform (Web), Fitness Tracker App (Mobile), Business Analytics Dashboard (Web), Enterprise Cloud Migration (Cloud), Customer Support AI (AI), Supply Chain Blockchain (Web). Guidelines: - Keep answers short and conversational — 2 to 4 sentences. - Never invent a specific price or quote. Pricing depends on project scope — invite the person to share more detail so the team can follow up. - If asked something unrelated to DCODE, its services, or general small talk, gently steer the conversation back to how you can help with their project. - If you don't know something specific, say so and suggest contacting the team directly rather than guessing. - Never claim to be human, and never claim abilities DCODE doesn't have.`;

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY_MESSAGES = 10;

app.post("/api/chat", chatLimiter, async (req, res) => {
  try {
    const { message, history } = req.body || {};

    if (typeof message !== "string" || !message.trim()) {
      return res
        .status(400)
        .json({ error: 'A non-empty "message" string is required.' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`,
      });
    }

    const safeHistory = Array.isArray(history)
      ? history
          .slice(-MAX_HISTORY_MESSAGES)
          .filter(
            (m) =>
              m &&
              typeof m.text === "string" &&
              (m.sender === "user" || m.sender === "bot")
          )
          .map((m) => ({
            role: m.sender === "user" ? "user" : "assistant",
            content: m.text.slice(0, MAX_MESSAGE_LENGTH),
          }))
      : [];

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...safeHistory,
      { role: "user", content: message.trim() },
    ];

    if (!process.env.DEEPSEEK_API_KEY) {
      console.error("DEEPSEEK_API_KEY is not set.");
      return res.status(500).json({
        error: "Chat is temporarily unavailable. Please contact us directly.",
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages,
          max_tokens: 300,
          temperature: 0.6,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error("DeepSeek API error:", response.status, errText);

      if (response.status === 429) {
        return res.status(429).json({
          error:
            "Felicity is a little busy right now — please try again shortly.",
        });
      }
      return res.status(502).json({
        error:
          "Felicity is having trouble connecting right now. Please email dcodedevs@gmail.com.",
      });
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      console.error("DeepSeek response had no content:", JSON.stringify(data));
      return res.status(502).json({
        error:
          "Felicity is having trouble connecting right now. Please email dcodedevs@gmail.com.",
      });
    }

    res.json({ reply });
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("DeepSeek request timed out");
      return res
        .status(504)
        .json({ error: "That took too long to answer — please try again." });
    }
    console.error("Unexpected /api/chat error:", err);
    res.status(500).json({
      error: "Something went wrong. Please try again or contact us directly.",
    });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Generic error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong." });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Felicity backend listening on port ${PORT}`);
  if (ALLOWED_ORIGINS.length === 0) {
    console.warn(
      "WARNING: ALLOWED_ORIGINS is empty — every browser request will be rejected with 403 until you set it."
    );
  } else {
    console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  }
});
