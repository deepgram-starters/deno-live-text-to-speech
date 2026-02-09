/**
 * Deno Live Text-to-Speech Starter - Backend Server
 *
 * This is a Deno HTTP/WebSocket server that provides real-time text-to-speech
 * by proxying messages between the client and Deepgram's Live TTS API.
 *
 * Key Features:
 * - WebSocket endpoint: /api/live-text-to-speech
 * - Bidirectional text/audio streaming
 * - JWT session auth with page nonce (production only)
 * - RESTful API with /api/* prefix
 * - Native TypeScript support
 * - No external web framework needed
 */

import { load } from "dotenv";
import TOML from "npm:@iarna/toml@2.2.5";
import * as jose from "jose";

// Load environment variables
await load({ export: true });

// ============================================================================
// CONFIGURATION - Customize these values for your needs
// ============================================================================

/**
 * Default text-to-speech model to use when none is specified
 * Options: "aura-2-thalia-en", "aura-2-theia-en", "aura-2-andromeda-en", etc.
 * See: https://developers.deepgram.com/docs/text-to-speech-models
 */
const DEFAULT_MODEL = "aura-2-thalia-en";

/**
 * Deepgram Live TTS WebSocket URL
 */
const DEEPGRAM_TTS_URL = "wss://api.deepgram.com/v1/speak";

/**
 * Server configuration - These can be overridden via environment variables
 */
interface ServerConfig {
  port: number;
  host: string;
}

const config: ServerConfig = {
  port: parseInt(Deno.env.get("PORT") || "8081"),
  host: Deno.env.get("HOST") || "0.0.0.0",
};

// ============================================================================
// SESSION AUTH - JWT tokens with page nonce for production security
// ============================================================================

const SESSION_SECRET = Deno.env.get("SESSION_SECRET") || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
const REQUIRE_NONCE = !!Deno.env.get("SESSION_SECRET");
const SESSION_SECRET_KEY = new TextEncoder().encode(SESSION_SECRET);

const sessionNonces = new Map<string, number>();
const NONCE_TTL_MS = 5 * 60 * 1000;
const JWT_EXPIRY = "1h";

/**
 * Generates a single-use nonce and stores it with an expiry
 */
function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validates and consumes a nonce (single-use). Returns true if valid.
 */
function consumeNonce(nonce: string): boolean {
  const expiry = sessionNonces.get(nonce);
  if (!expiry) return false;
  sessionNonces.delete(nonce);
  return Date.now() < expiry;
}

// Clean up expired nonces every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiry] of sessionNonces) {
    if (now >= expiry) sessionNonces.delete(nonce);
  }
}, 60_000);

let indexHtmlTemplate: string | null = null;
try {
  indexHtmlTemplate = await Deno.readTextFile(
    new URL("./frontend/dist/index.html", import.meta.url).pathname
  );
} catch {
  // No built frontend (dev mode)
}

/**
 * Creates a signed JWT session token
 */
async function createSessionToken(): Promise<string> {
  return await new jose.SignJWT({ iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(JWT_EXPIRY)
    .sign(SESSION_SECRET_KEY);
}

/**
 * Verifies a JWT session token
 */
async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jose.jwtVerify(token, SESSION_SECRET_KEY);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// API KEY LOADING - Load Deepgram API key from environment
// ============================================================================

/**
 * Loads the Deepgram API key from environment variables
 */
function loadApiKey(): string {
  const apiKey = Deno.env.get("DEEPGRAM_API_KEY");

  if (!apiKey) {
    console.error("\n❌ ERROR: Deepgram API key not found!\n");
    console.error("Please set your API key using one of these methods:\n");
    console.error("1. Create a .env file (recommended):");
    console.error("   DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("2. Environment variable:");
    console.error("   export DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("Get your API key at: https://console.deepgram.com\n");
    Deno.exit(1);
  }

  return apiKey;
}

const apiKey = loadApiKey();

// ============================================================================
// CORS CONFIGURATION
// ============================================================================

/**
 * Get CORS headers for API responses
 */
function getCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Nonce",
  };
}

// ============================================================================
// TYPES - TypeScript interfaces for WebSocket communication
// ============================================================================

interface ErrorMessage {
  type: "Error";
  description: string;
  code: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Build Deepgram WebSocket URL with query parameters
 */
function buildDeepgramUrl(queryParams: URLSearchParams): string {
  const model = queryParams.get("model") || DEFAULT_MODEL;
  const encoding = queryParams.get("encoding") || "linear16";
  const sampleRate = queryParams.get("sample_rate") || "48000";
  const container = queryParams.get("container") || "none";

  return `${DEEPGRAM_TTS_URL}?model=${model}&encoding=${encoding}&sample_rate=${sampleRate}&container=${container}`;
}

/**
 * Send error message to client WebSocket
 */
function sendError(socket: WebSocket, error: Error, code: string = "UNKNOWN_ERROR") {
  if (socket.readyState === WebSocket.OPEN) {
    const errorMsg: ErrorMessage = {
      type: "Error",
      description: error.message,
      code: code,
    };
    socket.send(JSON.stringify(errorMsg));
  }
}

// ============================================================================
// WEBSOCKET HANDLERS
// ============================================================================

/**
 * Handle live TTS WebSocket connection
 * Establishes bidirectional proxy between client and Deepgram
 */
async function handleLiveTts(
  clientSocket: WebSocket,
  queryParams: URLSearchParams
) {
  console.log("Client connected to /api/live-text-to-speech");

  let deepgramWs: WebSocket | null = null;

  try {
    // Build Deepgram WebSocket URL with parameters
    const deepgramUrl = buildDeepgramUrl(queryParams);
    console.log("Connecting to Deepgram TTS:", deepgramUrl);

    // Connect to Deepgram with authorization
    deepgramWs = new WebSocket(deepgramUrl, {
      headers: {
        Authorization: `Token ${apiKey}`,
      },
    });

    // Wait for Deepgram connection to open
    await new Promise((resolve, reject) => {
      if (!deepgramWs) return reject(new Error("deepgramWs is null"));

      deepgramWs.onopen = () => {
        console.log("✓ Connected to Deepgram TTS");
        resolve(null);
      };

      deepgramWs.onerror = (err) => {
        console.error("Deepgram connection error:", err);
        reject(new Error("Failed to connect to Deepgram"));
      };
    });

    // Forward messages from client to Deepgram (text data)
    clientSocket.onmessage = (event) => {
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(event.data);
      }
    };

    // Forward messages from Deepgram to client (audio data)
    deepgramWs.onmessage = (event) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    // Handle client disconnect
    clientSocket.onclose = () => {
      console.log("Client disconnected");
      if (deepgramWs) {
        deepgramWs.close();
      }
    };

    // Handle client errors
    clientSocket.onerror = (err) => {
      console.error("Client WebSocket error:", err);
      if (deepgramWs) {
        deepgramWs.close();
      }
    };

    // Handle Deepgram disconnect
    deepgramWs.onclose = (event) => {
      console.log(`Deepgram connection closed: ${event.code} ${event.reason}`);
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close();
      }
    };

    // Handle Deepgram errors
    deepgramWs.onerror = (err) => {
      console.error("Deepgram WebSocket error:", err);
      sendError(clientSocket, new Error("Deepgram connection error"), "DEEPGRAM_ERROR");
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close();
      }
    };

  } catch (err) {
    console.error("Error setting up live TTS:", err);
    sendError(clientSocket, err as Error, "CONNECTION_FAILED");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(3000, "Setup failed");
    }
    if (deepgramWs) {
      deepgramWs.close();
    }
  }
}

// ============================================================================
// SESSION ROUTE HANDLERS
// ============================================================================

/**
 * Serve index.html with injected session nonce (production only)
 */
function handleServeIndex(): Response {
  if (!indexHtmlTemplate) {
    return new Response("Frontend not built. Run make build first.", { status: 404 });
  }
  // Cleanup expired nonces
  const now = Date.now();
  for (const [nonce, expiry] of sessionNonces) {
    if (now >= expiry) sessionNonces.delete(nonce);
  }
  const nonce = generateNonce();
  sessionNonces.set(nonce, Date.now() + NONCE_TTL_MS);
  const html = indexHtmlTemplate.replace(
    "</head>",
    `<meta name="session-nonce" content="${nonce}">\n</head>`
  );
  return new Response(html, {
    headers: { "Content-Type": "text/html", ...getCorsHeaders() },
  });
}

/**
 * GET /api/session
 * Issues a JWT. In production, requires valid nonce via X-Session-Nonce header.
 */
async function handleGetSession(req: Request): Promise<Response> {
  if (REQUIRE_NONCE) {
    const nonce = req.headers.get("X-Session-Nonce");
    if (!nonce || !consumeNonce(nonce)) {
      return Response.json(
        { error: { type: "AuthenticationError", code: "INVALID_NONCE", message: "Valid session nonce required. Please refresh the page." } },
        { status: 403, headers: getCorsHeaders() }
      );
    }
  }
  const token = await createSessionToken();
  return Response.json({ token }, { headers: getCorsHeaders() });
}

// ============================================================================
// API ROUTE HANDLERS
// ============================================================================

/**
 * GET /api/metadata
 * Returns metadata about this starter application
 */
async function handleMetadata(): Promise<Response> {
  try {
    const tomlContent = await Deno.readTextFile("./deepgram.toml");
    const config = TOML.parse(tomlContent);

    if (!config.meta) {
      return Response.json(
        {
          error: "INTERNAL_SERVER_ERROR",
          message: "Missing [meta] section in deepgram.toml",
        },
        { status: 500, headers: getCorsHeaders() }
      );
    }

    return Response.json(config.meta, { headers: getCorsHeaders() });
  } catch (error) {
    console.error("Error reading metadata:", error);
    return Response.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "Failed to read metadata from deepgram.toml",
      },
      { status: 500, headers: getCorsHeaders() }
    );
  }
}

// ============================================================================
// CORS PREFLIGHT HANDLER
// ============================================================================

/**
 * Handle CORS preflight OPTIONS requests
 */
function handlePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}

// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handlePreflight();
  }

  // Session routes (unprotected)
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return handleServeIndex();
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    return await handleGetSession(req);
  }

  // WebSocket endpoint: /api/live-text-to-speech (auth via subprotocol)
  if (url.pathname === "/api/live-text-to-speech") {
    const upgrade = req.headers.get("upgrade") || "";

    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426, headers: getCorsHeaders() });
    }

    // Validate JWT from subprotocol
    const protocols = req.headers.get("sec-websocket-protocol") || "";
    const protocolList = protocols.split(",").map((p) => p.trim());
    const tokenProto = protocolList.find((p) => p.startsWith("access_token."));

    if (!tokenProto) {
      return new Response("Unauthorized", { status: 401, headers: getCorsHeaders() });
    }

    const jwtToken = tokenProto.slice("access_token.".length);
    if (!(await verifySessionToken(jwtToken))) {
      return new Response("Unauthorized", { status: 401, headers: getCorsHeaders() });
    }

    // Upgrade with accepted subprotocol
    const { socket, response } = Deno.upgradeWebSocket(req, {
      protocol: tokenProto,
    });

    // Handle the WebSocket connection
    handleLiveTts(socket, url.searchParams);

    return response;
  }

  // Metadata (unprotected)
  if (req.method === "GET" && url.pathname === "/api/metadata") {
    return handleMetadata();
  }

  // 404 for all other routes
  return Response.json(
    { error: "Not Found", message: "Endpoint not found" },
    { status: 404, headers: getCorsHeaders() }
  );
}

// ============================================================================
// SERVER START
// ============================================================================

const nonceStatus = REQUIRE_NONCE ? " (nonce required)" : "";
console.log("\n" + "=".repeat(70));
console.log(`🚀 Backend API Server running at http://localhost:${config.port}`);
console.log("");
console.log(`📡 GET  /api/session${nonceStatus}`);
console.log(`📡 WS   /api/live-text-to-speech (auth required)`);
console.log(`📡 GET  /api/metadata`);
console.log("=".repeat(70) + "\n");

Deno.serve({ port: config.port, hostname: config.host }, handleRequest);
