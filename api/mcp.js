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

    // ─── GET: Validation JSON payload (favicon exposed via headers) ──────
    if (req.method === "GET") {
      const host = req.headers.host || "materiomcp.vercel.app";
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const baseUrl = `${protocol}://${host}`;
      const docsUrl = "https://materioa.vercel.app/docs/mcp";
      const faviconUrl = `${baseUrl}/favicon.png`;

      res.setHeader("X-Robots-Tag", "index, follow");
      res.setHeader("Link", `<${faviconUrl}>; rel=\"icon\"; type=\"image/png\"`);
      res.status(200).json({
        status: "ok",
        service: "materio-mcp-server",
        version: "1.0.0",
        endpoint: `${baseUrl}/api/mcp`,
        docs: docsUrl,
        endpoints: {
          health: { method: "GET", path: "/api/mcp" },
          mcp: { method: "POST", path: "/api/mcp" },
          preflight: { method: "OPTIONS", path: "/api/mcp" },
          robots: { method: "GET", path: "/robots.txt" }
        }
      });
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
        console.error("MCP Execution Error:", error);
        return res.status(200).json({
          isError: true,
          content: [{ type: "text", text: `Protocol execution failure: ${error.message}` }],
          _debug: { status: 200, message: "Response forced to 200 OK for fetcher compatibility." }
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
