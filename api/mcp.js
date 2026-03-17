/**
 * Materio MCP Server — Vercel Serverless HTTP Entry Point
 * 
 * This is the Vercel serverless function that handles MCP requests.
 * Each request is handled via manual JSON-RPC handlers.
 * 
 * Endpoint: POST /api/mcp
 * 
 * © 2024-2026, Materio by JTC.
 */

import { createServer } from "../server.js";

/**
 * Vercel serverless handler for MCP over HTTP.
 * 
 * Supports:
 *  - POST /api/mcp  → MCP JSON-RPC requests
 *  - GET  /api/mcp  → Health check / info
 *  - OPTIONS /api/mcp → CORS preflight
 */
export default async function handler(req, res) {
  // 🛡️ MCP Safety Guard: Suppress all console output to prevent pollution.
  // This prevents libraries (like pdf-parse) from polluting responses with 
  // warnings/logs/info/debug, which would break the MCP JSON-RPC protocol.
  // Only apply this once per request, not for every tool call.
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  
  console.log = console.warn = console.info = console.debug = (...args) => {
    // Silently discard or redirect to console.error if debugging is needed
    // For now, just suppress to keep responses clean
  };

  try {
    // ─── CORS headers (allow any origin for MCP clients) ───────────────────
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    // ─── OPTIONS: CORS preflight ───────────────────────────────────────────
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    // ─── GET: Health check / server info ───────────────────────────────────
    if (req.method === "GET") {
      res.status(200).json({
        name: "materio-mcp-server",
        version: "1.0.0",
        description: "Materio MCP Server — search and read educational PDFs via MCP protocol",
        status: "ok",
        transport: "streamable-http",
        endpoint: "/api/mcp",
        logo: "/favicon.png",
        icon: "/favicon.png",
        usage: "Send MCP JSON-RPC requests via POST to this endpoint."
      });
      return;
    }

    // ─── POST: Handle MCP requests ─────────────────────────────────────────
    if (req.method === "POST") {
      try {
        const server = createServer();
        const { method, params, id } = req.body;

        // 🛡️ Universal Handler: Manual execution for initialize, tools/list, and tools/call
        if (method === "initialize") {
          res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {
                tools: {
                  listChanged: true
                }
              },
              serverInfo: {
                name: "materio-mcp-server",
                version: "1.0.0"
              }
            }
          });
          return;
        }

        if (method === "tools/list") {
          try {
            const result = await server.listToolsManual();
            res.status(200).json({
              jsonrpc: "2.0",
              result,
              id
            });
          } catch (e) {
            res.status(500).json({ error: e.message });
          } finally {
            try { await server.close(); } catch (e) {}
          }
          return;
        }

        if (method === "tools/call") {
          try {
            // 🛡️ Argument Resolver:
            // ChatGPT sometimes sends arguments nested in 'params.arguments', 
            // but sometimes sends them directly in 'params'. This handles both.
            const toolName = params?.name;
            const toolArgs = params?.arguments || (params ? { ...params } : {});
            
            // Clean up toolArgs so we don't pass 'name' as an argument to the tool
            if (toolArgs.name) delete toolArgs.name;

            const result = await server.executeToolManual(toolName, toolArgs);
            res.status(200).json({
              jsonrpc: "2.0",
              result,
              id
            });
          } catch (toolError) {
            res.status(200).json({
              jsonrpc: "2.0",
              error: { code: -32603, message: toolError.message },
              id
            });
          } finally {
            // Explicit cleanup to prevent Windows-specific handle assertions
            try { await server.close(); } catch (e) {}
          }
          return;
        }

        // ─── Unsupported Methods ────────────────────────────────────────────
        // For any other MCP method not handled above, return error
        res.status(200).json({
          jsonrpc: "2.0",
          error: { 
            code: -32601, 
            message: `Method '${method}' is not supported by this MCP server`
          },
          id
        });
        return;
      } catch (error) {
        // Use original console.error for logging errors
        originalLog("MCP handler error:", error);
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: req.body?.id || null
        });
      }
      return;
    }

    // ─── Other methods: 405 ────────────────────────────────────────────────
    res.status(405).json({
      error: "Method not allowed. Use POST for MCP requests, GET for server info."
    });
  } finally {
    // Restore original console methods
    console.log = originalLog;
    console.warn = originalWarn;
    console.info = originalInfo;
    console.debug = originalDebug;
  }
}
