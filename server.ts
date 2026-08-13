/**
 * Deno Live Text-to-Speech Starter - Backend Server
 *
 * This is a Deno HTTP/WebSocket server that provides real-time text-to-speech
 * by proxying messages between the client and Deepgram's Live TTS API.
 *
 * Key Features:
 * - WebSocket endpoint: /api/live-text-to-speech
 * - Bidirectional text/audio streaming
 * - JWT session auth for API protection
 * - RESTful API with /api/* prefix
 * - Native TypeScript support
 * - No external web framework needed
 */

import { load } from "dotenv";
import TOML from "npm:@iarna/toml@2.2.5";
import * as jose from "jose";
import { DeepgramClient } from "@deepgram/sdk";

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
// SESSION AUTH - JWT tokens for API protection
// ============================================================================

const SESSION_SECRET = Deno.env.get("SESSION_SECRET") || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
const SESSION_SECRET_KEY = new TextEncoder().encode(SESSION_SECRET);

const JWT_EXPIRY = "1h";

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
// DEEPGRAM SDK CLIENT
// ============================================================================

// A single SDK client is reused across connections; auth is resolved from the
// API key here, so the browser never sees it.
//
// DEEPGRAM_BASE_URL (e.g. a staging host like wss://api.staging.deepgram.com)
// overrides the default production endpoint. The speak websocket uses
// `environment.production`, so we set that plus the REST `base`.
const baseUrl = Deno.env.get("DEEPGRAM_BASE_URL");
const httpBase = baseUrl
  ?.replace(/^wss:\/\//, "https://")
  .replace(/^ws:\/\//, "http://");
const deepgram = new DeepgramClient({
  apiKey,
  ...(baseUrl && httpBase
    ? {
        environment: {
          base: httpBase,
          production: baseUrl,
          agent: baseUrl,
          agentRest: httpBase,
        },
      }
    : {}),
});
if (baseUrl) {
  console.log(`Using custom Deepgram base URL: ${baseUrl}`);
}

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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
 * Build Deepgram live-TTS options from the client's query params.
 * These are passed to `deepgram.speak.v1.createConnection({ ... })`; the SDK
 * serializes them onto the websocket query string.
 */
function buildSpeakOptions(queryParams: URLSearchParams) {
  return {
    model: queryParams.get("model") || DEFAULT_MODEL,
    encoding: queryParams.get("encoding") || "linear16",
    sample_rate: queryParams.get("sample_rate") || "48000",
    container: queryParams.get("container") || "none",
  };
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
type SpeakConnection = Awaited<
  ReturnType<typeof deepgram.speak.v1.createConnection>
>;

async function handleLiveTts(
  clientSocket: WebSocket,
  queryParams: URLSearchParams
) {
  console.log("Client connected to /api/live-text-to-speech");

  const options = buildSpeakOptions(queryParams);
  console.log("Connecting to Deepgram TTS:", options);

  // Buffer any browser control messages that arrive before the socket is open.
  let dgReady = false;
  const pending: Record<string, unknown>[] = [];

  // Create the Deepgram TTS connection object (not yet connected). The SDK
  // manages the websocket, auth, reconnection and (de)serialization; its
  // WrappedSpeakV1Socket delivers binary audio frames as-is.
  let dgConn: SpeakConnection;
  try {
    dgConn = await deepgram.speak.v1.createConnection(options);
  } catch (err) {
    console.error("Failed to create Deepgram connection:", err);
    sendError(clientSocket, err as Error, "CONNECTION_FAILED");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(3000, "Failed to reach Deepgram");
    }
    return;
  }

  // Route a control message (Speak / Flush / Clear / Close) from the browser to
  // the matching SDK method. Speak text uses sendText on speak v1.
  const dispatchControl = (msg: Record<string, unknown>) => {
    try {
      switch (msg.type) {
        case "Speak":
          dgConn.sendText({ type: "Speak", text: String(msg.text ?? "") });
          break;
        case "Flush":
          dgConn.sendFlush({ type: "Flush" });
          break;
        case "Clear":
          dgConn.sendClear({ type: "Clear" });
          break;
        case "Close":
          dgConn.sendClose({ type: "Close" });
          break;
        default:
          console.warn("Ignoring unknown client control message type:", msg.type);
      }
    } catch (err) {
      console.error("Failed to forward control message to Deepgram:", err);
    }
  };

  // Deepgram -> browser. Binary audio frames are forwarded as-is; JSON control
  // messages (Metadata / Flushed / Cleared / Warning) are re-serialized so the
  // frontend sees the same JSON it received from the raw socket before.
  dgConn.on("message", (data: unknown) => {
    if (clientSocket.readyState !== WebSocket.OPEN) return;
    if (
      data instanceof ArrayBuffer ||
      data instanceof Blob ||
      ArrayBuffer.isView(data)
    ) {
      clientSocket.send(data as ArrayBuffer | Blob | ArrayBufferView);
    } else if (typeof data === "string") {
      clientSocket.send(data);
    } else {
      clientSocket.send(JSON.stringify(data));
    }
  });

  dgConn.on("open", () => {
    console.log("✓ Connected to Deepgram TTS");
  });

  dgConn.on("error", (err) => {
    console.error("Deepgram socket error:", err);
    sendError(clientSocket, new Error("Deepgram connection error"), "DEEPGRAM_ERROR");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close();
    }
  });

  dgConn.on("close", () => {
    console.log("Deepgram connection closed");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close();
    }
  });

  // browser -> Deepgram. TTS input is JSON control (Speak / Flush / Clear / Close).
  clientSocket.onmessage = (event) => {
    const data = event.data;
    if (typeof data !== "string") {
      console.warn("Ignoring unexpected binary frame from client");
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn("Ignoring non-JSON text message from client");
      return;
    }
    if (!dgReady) {
      pending.push(msg);
      return;
    }
    dispatchControl(msg);
  };

  // Handle client disconnect
  clientSocket.onclose = () => {
    console.log("Client disconnected");
    try {
      dgConn.close();
    } catch {
      // already closed
    }
  };

  // Handle client errors
  clientSocket.onerror = (err) => {
    console.error("Client WebSocket error:", err);
    try {
      dgConn.close();
    } catch {
      // already closed
    }
  };

  // Open the Deepgram connection and flush anything the browser sent early.
  try {
    dgConn.connect();
    await dgConn.waitForOpen();
    dgReady = true;
    for (const msg of pending) {
      dispatchControl(msg);
    }
    pending.length = 0;
  } catch (err) {
    console.error("Deepgram connection did not open:", err);
    sendError(clientSocket, err as Error, "CONNECTION_FAILED");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(3000, "Setup failed");
    }
  }
}

// ============================================================================
// SESSION ROUTE HANDLERS
// ============================================================================

/**
 * Serve index.html (production only)
 */
function handleServeIndex(): Response {
  if (!indexHtmlTemplate) {
    return new Response("Frontend not built. Run make build first.", { status: 404 });
  }
  return new Response(indexHtmlTemplate, {
    headers: { "Content-Type": "text/html", ...getCorsHeaders() },
  });
}

/**
 * GET /api/session
 * Issues a signed JWT session token.
 */
async function handleGetSession(): Promise<Response> {
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
    return await handleGetSession();
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

console.log("\n" + "=".repeat(70));
console.log(`🚀 Backend API Server running at http://localhost:${config.port}`);
console.log("");
console.log(`📡 GET  /api/session`);
console.log(`📡 WS   /api/live-text-to-speech (auth required)`);
console.log(`📡 GET  /api/metadata`);
console.log("=".repeat(70) + "\n");

Deno.serve({ port: config.port, hostname: config.host }, handleRequest);
