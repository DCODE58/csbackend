require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

// --- CORS: only allow requests from your own site --------------------------
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server / curl / health checks with no Origin header
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
  })
);

// --- Rate limiting: protect your DeepSeek quota from abuse ------------------
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15, // 15 messages/minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many messages sent — please wait a moment and try again.",
  },
});

// --- Felicity's persona + grounded company facts ----------------------------
// Keeping real facts here (not left to the model to guess) avoids hallucinated
// prices, contact details, or made-up projects.
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
      return res
        .status(400)
        .json({
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
      return res
        .status(500)
        .json({
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
        return res
          .status(429)
          .json({
            error:
              "Felicity is a little busy right now — please try again shortly.",
          });
      }
      return res
        .status(502)
        .json({
          error:
            "Felicity is having trouble connecting right now. Please email dcodedevs@gmail.com.",
        });
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      console.error("DeepSeek response had no content:", JSON.stringify(data));
      return res
        .status(502)
        .json({
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
    res
      .status(500)
      .json({
        error: "Something went wrong. Please try again or contact us directly.",
      });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Generic error handler (e.g. CORS rejection thrown above)
app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed." });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong." });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Felicity backend listening on port ${PORT}`);
  if (ALLOWED_ORIGINS.length === 0) {
    console.warn(
      "WARNING: ALLOWED_ORIGINS is empty — no browser origins will be permitted until you set it in .env"
    );
  }
});
