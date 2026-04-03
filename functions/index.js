/**
 * Firebase Cloud Function — Gemini API Proxy
 *
 * Keeps the Gemini API key server-side only.
 * Frontend sends model + contents + generationConfig;
 * this function appends the real key and forwards to Gemini.
 *
 * === SETUP ===
 * 1. cd functions && npm install
 * 2. Set the API key as a secret:
 *      firebase functions:secrets:set GEMINI_API_KEY
 *    (paste your Gemini key when prompted)
 * 3. Deploy:
 *      firebase deploy --only functions
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

// The Gemini API key — stored as a Firebase secret, never in code.
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// Whitelist of allowed models to prevent abuse
const ALLOWED_MODELS = new Set([
  "gemini-3.1-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
]);

// Allowed origins (update with your actual domain)
const ALLOWED_ORIGINS = [
  "https://cute-kitten.cfd",
  "https://www.cute-kitten.cfd",
  "https://miupack.web.app",
  "https://miupack.firebaseapp.com",
];

exports.geminiProxy = onRequest(
  {
    secrets: [GEMINI_API_KEY],
    cors: ALLOWED_ORIGINS,
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    maxInstances: 20,
  },
  async (req, res) => {
    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { model, contents, generationConfig, feature } = req.body;

    // --- Validate model ---
    if (!model || !ALLOWED_MODELS.has(model)) {
      return res.status(400).json({ error: "Invalid or disallowed model" });
    }

    // --- Validate contents ---
    if (!contents || !Array.isArray(contents) || contents.length === 0) {
      return res.status(400).json({ error: "Missing contents" });
    }

    // --- Optional: verify Firebase ID token for rate-limiting ---
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice(7);
        const decoded = await admin.auth().verifyIdToken(token);
        // You can use decoded.uid for per-user rate limiting here
        req.uid = decoded.uid;
      } catch (e) {
        // Token invalid — still allow anonymous usage but you could reject:
        // return res.status(401).json({ error: "Invalid auth token" });
      }
    }

    // --- Forward to Gemini ---
    const apiKey = GEMINI_API_KEY.value();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    try {
      const geminiResp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents, generationConfig }),
      });

      const data = await geminiResp.json();

      if (!geminiResp.ok) {
        // Forward Gemini's error status but strip the API key from any message
        const errMsg = data.error?.message?.replace(apiKey, "[REDACTED]") || "Gemini API error";
        return res.status(geminiResp.status).json({ error: errMsg });
      }

      return res.status(200).json(data);
    } catch (e) {
      console.error("Gemini proxy error:", e);
      return res.status(502).json({ error: "Failed to reach Gemini API" });
    }
  }
);
