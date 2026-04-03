/**
 * Firebase Cloud Functions — Gemini API Proxy + VIP Payment Verification
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
const db = admin.firestore();

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

// =============================================
// 1) Gemini API Proxy (unchanged)
// =============================================
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
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { model, contents, generationConfig, feature } = req.body;

    if (!model || !ALLOWED_MODELS.has(model)) {
      return res.status(400).json({ error: "Invalid or disallowed model" });
    }
    if (!contents || !Array.isArray(contents) || contents.length === 0) {
      return res.status(400).json({ error: "Missing contents" });
    }

    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice(7);
        const decoded = await admin.auth().verifyIdToken(token);
        req.uid = decoded.uid;
      } catch (e) {
        // Token invalid — still allow anonymous usage
      }
    }

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
        const errMsg =
          data.error?.message?.replace(apiKey, "[REDACTED]") ||
          "Gemini API error";
        return res.status(geminiResp.status).json({ error: errMsg });
      }

      return res.status(200).json(data);
    } catch (e) {
      console.error("Gemini proxy error:", e);
      return res.status(502).json({ error: "Failed to reach Gemini API" });
    }
  }
);

// =============================================
// 2) VIP Payment Verification & Upgrade
// =============================================
//
// Frontend calls this after user pays.
// Server verifies on-chain, then writes VIP status to Firestore.
// Client NEVER writes isVip / vipExpiry directly.

const BSC_RECEIVER = "0x754104292463f0a14ae23c79b2d3395d3398cccc";
const SOL_RECEIVER = "8PHJFMp2WDujgs1xQJZtoYVcPPxy6cC5QHoaePaMnHrX";
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const USDT_SOL_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const VIP_PRICE = 9.9;

// --- BSC on-chain verification ---
async function verifyBSCPayment(paymentInitTime) {
  try {
    const cutoff = Math.floor((paymentInitTime || Date.now() - 300000) / 1000);
    const url =
      "https://api.bscscan.com/api?module=account&action=tokentx" +
      "&contractaddress=" + USDT_BSC +
      "&address=" + BSC_RECEIVER +
      "&page=1&offset=10&sort=desc";

    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== "1" || !data.result) return false;

    for (const tx of data.result) {
      const ts = parseInt(tx.timeStamp);
      const value = parseFloat(tx.value) / 1e18;
      if (
        ts >= cutoff &&
        value >= VIP_PRICE - 0.01 &&
        tx.to.toLowerCase() === BSC_RECEIVER.toLowerCase()
      ) {
        return true;
      }
    }
    return false;
  } catch (e) {
    console.error("BSC verify error:", e);
    return false;
  }
}

// --- Solana on-chain verification ---
async function verifySolPayment(paymentInitTime) {
  try {
    const cutoff = Math.floor((paymentInitTime || Date.now() - 300000) / 1000);

    const resp = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [SOL_RECEIVER, { limit: 10 }],
      }),
    });
    const data = await resp.json();
    if (!data.result || !data.result.length) return false;

    for (const sig of data.result) {
      if (sig.blockTime && sig.blockTime >= cutoff && !sig.err) {
        const txResp = await fetch("https://api.mainnet-beta.solana.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [
              sig.signature,
              { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
            ],
          }),
        });
        const txData = await txResp.json();
        const meta = txData.result?.meta;
        if (meta && meta.postTokenBalances) {
          for (const bal of meta.postTokenBalances) {
            if (bal.mint === USDT_SOL_MINT) return true;
          }
        }
      }
    }
    return false;
  } catch (e) {
    console.error("SOL verify error:", e);
    return false;
  }
}

exports.verifyVipPayment = onRequest(
  {
    cors: ALLOWED_ORIGINS,
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 10,
  },
  async (req, res) => {
    // --- Only POST ---
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // --- Must be authenticated ---
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    let uid;
    try {
      const token = authHeader.slice(7);
      const decoded = await admin.auth().verifyIdToken(token);
      uid = decoded.uid;
    } catch (e) {
      return res.status(401).json({ error: "Invalid auth token" });
    }

    // --- Check if already VIP ---
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.isVip) {
        const expDate = userData.vipExpiry?.toDate
          ? userData.vipExpiry.toDate()
          : userData.vipExpiry
            ? new Date(userData.vipExpiry)
            : null;
        if (expDate && expDate > new Date()) {
          return res.status(200).json({ success: true, alreadyVip: true });
        }
      }
    }

    // --- Validate request body ---
    const { chain, paymentInitTime } = req.body;
    if (!chain || !["bsc", "sol"].includes(chain)) {
      return res.status(400).json({ error: "Invalid chain (bsc or sol)" });
    }
    if (!paymentInitTime || typeof paymentInitTime !== "number") {
      return res.status(400).json({ error: "Invalid paymentInitTime" });
    }

    // Reject if paymentInitTime is too old (> 30 min) or in the future
    const now = Date.now();
    if (paymentInitTime > now + 60000 || paymentInitTime < now - 1800000) {
      return res
        .status(400)
        .json({ error: "paymentInitTime out of valid range" });
    }

    // --- Verify on-chain ---
    let verified = false;
    if (chain === "bsc") {
      verified = await verifyBSCPayment(paymentInitTime);
    } else {
      verified = await verifySolPayment(paymentInitTime);
    }

    if (!verified) {
      return res
        .status(402)
        .json({ error: "Payment not found on-chain", verified: false });
    }

    // --- Payment verified — upgrade to VIP (server-side write) ---
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);

    try {
      await userRef.set(
        {
          isVip: true,
          vipExpiry: admin.firestore.Timestamp.fromDate(expiry),
          vipActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
          vipChain: chain,
        },
        { merge: true }
      );
    } catch (e) {
      console.error("Firestore VIP write failed:", e);
      return res.status(500).json({ error: "Failed to upgrade VIP status" });
    }

    return res.status(200).json({
      success: true,
      verified: true,
      vipExpiry: expiry.toISOString(),
    });
  }
);
