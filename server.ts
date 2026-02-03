/**
 * Deno Live Text-to-Speech Starter - Backend Server
 *
 * This is a Deno HTTP/WebSocket server that provides real-time text-to-speech
 * by proxying messages between the client and Deepgram's Live TTS API.
 *
 * Key Features:
 * - WebSocket endpoint: /tts/stream
 * - Bidirectional text/audio streaming
 * - Proxies to Vite dev server in development
 * - Serves static frontend in production
 * - Native TypeScript support
 * - No external web framework needed
 */

import { load } from "dotenv";
import TOML from "npm:@iarna/toml@2.2.5";

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
  frontendPort: number;
}

const config: ServerConfig = {
  port: parseInt(Deno.env.get("PORT") || "8081"),
  host: Deno.env.get("HOST") || "0.0.0.0",
  frontendPort: parseInt(Deno.env.get("FRONTEND_PORT") || "8080"),
};

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
    "Access-Control-Allow-Origin": `http://localhost:${config.frontendPort}`,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
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
  console.log("Client connected to /tts/stream");

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

  // WebSocket endpoint: /tts/stream
  if (url.pathname === "/tts/stream") {
    const upgrade = req.headers.get("upgrade") || "";

    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426, headers: getCorsHeaders() });
    }

    // Upgrade to WebSocket
    const { socket, response } = Deno.upgradeWebSocket(req);

    // Handle the WebSocket connection
    handleLiveTts(socket, url.searchParams);

    return response;
  }

  // API endpoint: /api/metadata
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
console.log(`📡 CORS enabled for http://localhost:${config.frontendPort}`);
console.log(`\n💡 Frontend should be running on http://localhost:${config.frontendPort}`);
console.log("=".repeat(70) + "\n");

Deno.serve({ port: config.port, hostname: config.host }, handleRequest);
