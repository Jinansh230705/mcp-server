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
  //  MCP Safety Guard: Suppress all console output to prevent pollution.
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

    // ─── robots.txt ────────────────────────────────────────────────────────
    if (req.url === "/robots.txt") {
      res.setHeader("Content-Type", "text/plain");
      res.status(200).send("User-agent: *\nAllow: /\nSitemap: https://materiomcp.vercel.app/api/mcp");
      return;
    }

    // ─── GET: Meta-Identity Page (Fixes crawler status errors) ───────────
    if (req.method === "GET") {
      res.status(200).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Materio MCP | Unified Education API</title>
          <link rel="icon" href="data:image/x-icon;base64,AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMzMzADMzMwAzMzMAMzMzADMzMwAzMzMAMzMzADMzMwAzMzMAMzMzADMzMwAzMzMAMzMzADMzMwAAMzMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A">
          <style>
            body { background: #0c0c0c; color: #fff; font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
            .card { background: #1a1a1a; padding: 2.5rem; border-radius: 20px; border: 1px solid #333; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-top: 4px solid #00c6ff; }
            h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.5px; }
            p { opacity: 0.6; font-size: 0.9rem; margin-top: 0.5rem; }
            .tag { display: inline-block; background: #222; border: 1px solid #444; padding: 4px 12px; border-radius: 20px; font-size: 0.7rem; color: #00c6ff; margin-top: 1rem; text-transform: uppercase; letter-spacing: 1px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Materio MCP Server</h1>
            <p>Active and Secure. Ready for Protocol Handshake.</p>
            <div class="tag">Status: 200 OK</div>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // ─── POST: Handle MCP requests ─────────────────────────────────────────
    if (req.method === "POST") {
      try {
        const server = createServer();
        const { method, params, id } = req.body;

        //  Universal Handler: Manual execution for initialize, tools/list, and tools/call
        const possibleTools = ["list_resources", "get_resource", "fetch_pdf", "share_link", "subject_overview", "search"];
        const toolFromUrl = possibleTools.find(t => req.url && req.url.includes(t));
        const isRestfulChatGPT = !!toolFromUrl;
        const effectiveMethod = isRestfulChatGPT ? "tools/call" : method;

        if (effectiveMethod === "initialize") {
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

        if (effectiveMethod === "tools/list") {
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
            try { await server.close(); } catch (e) { }
          }
          return;
        }

        if (effectiveMethod === "tools/call") {
          try {
            //  Argument Resolver:
            // Match the tool explicitly
            const toolName = params?.name || toolFromUrl;
            
            // If RESTful ChatGPT, args are the entire body (or params if nested)
            let rawArgs = req.body || {};
            if (params) rawArgs = params.arguments || params;
            
            const toolArgs = { ...rawArgs };
            
            // Clean up toolArgs so we don't pass system keys
            delete toolArgs.name;
            delete toolArgs.method;
            delete toolArgs.id;
            delete toolArgs.params;
            delete toolArgs.jsonrpc;

            const result = await server.executeToolManual(toolName, toolArgs);

            // Give ChatGPT pure response strings, unwrap the MCP protocol constraints
            if (isRestfulChatGPT) {
               if (result.isError) {
                  res.status(400).json({ error: result.content[0].text });
               } else {
                  res.status(200).json({ response: result.content[0].text });
               }
               return;
            }

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
            try { await server.close(); } catch (e) { }
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
