import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import express from "express";
import fetch from "node-fetch";
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

// --- Manually load .env.local ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envLocalPath = path.resolve(__dirname, ".env.local");
if (fs.existsSync(envLocalPath)) {
  const envConfig = fs.readFileSync(envLocalPath, "utf-8");
  for (const line of envConfig.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const [key, ...value] = trimmed.split("=");
      if (!process.env[key]) process.env[key] = value.join("=").trim();
    }
  }
}

// --- Constants ---
const CDN_BASE = "https://cdn-materioa.vercel.app";
const RESOURCE_LIB_URL = `${CDN_BASE}/databases/beta/resource.lib.json`;
const CHARACTER_LIMIT = 80000;

const ENABLE_RAG = process.env.ENABLE_RAG !== "false";
const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent";

const supabase = createClient(
  process.env.SUPABASE_URL || "https://supabase-placeholder",
  process.env.SUPABASE_SERVICE_KEY || "placeholder"
);

const FAVICON_BASE64 = "data:image/x-icon;base64,AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMzMzADMzMwAzMzMAMzMzADMzMwAzMzMAMzMzADMzMwAzMzMAMzMzADMzMwAzMzMAMzMzADMzMwAAMzMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A////AP///wD///8A";

// --- Helpers ---
let resourceLibCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function generateMaskedUrl(actualUrl) {
  try {
    const response = await fetch("https://materioa.vercel.app/api/v2/features?action=pdf-share&subAction=create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actualUrl })
    });
    if (response.ok) {
      const data = await response.json();
      if (data.maskId) {
        return `https://materioa.vercel.app/?share=${data.maskId}`;
      }
    }
  } catch (err) { }
  return actualUrl;
}

async function getResourceLibrary() {
  const now = Date.now();
  if (resourceLibCache && (now - cacheTimestamp) < CACHE_TTL) return resourceLibCache;
  try {
    const response = await fetch(RESOURCE_LIB_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    resourceLibCache = await response.json();
    cacheTimestamp = now;
    return resourceLibCache;
  } catch (error) {
    if (resourceLibCache) return resourceLibCache;
    throw error;
  }
}

function buildPdfUrl(semester, subject, topic) {
  if (semester === "9999") return `${CDN_BASE}/pdfs/${semester}/${subject}/vault/${encodeURIComponent(topic)}.pdf`;
  return `${CDN_BASE}/pdfs/${semester}/${encodeURIComponent(subject)}/${encodeURIComponent(topic)}.pdf`;
}

async function fetchPdfText(url) {
  const encodedUrl = new URL(url).toString();
  const response = await fetch(encodedUrl);
  if (!response.ok) throw new Error(`Failed to fetch PDF: HTTP ${response.status} from ${url}`);
  
  const buffer = await response.arrayBuffer();
  const uint8 = new Uint8Array(buffer);
  
  const pdfParse = (await import("pdf-parse")).default;
  const data = await pdfParse(Buffer.from(uint8));
  return data.text;
}

function buildSearchIndex(library) {
  const index = [];
  for (const [semester, subjects] of Object.entries(library)) {
    if (semester === "9999") {
      const vaultData = subjects;
      if (vaultData.Vault && Array.isArray(vaultData.Vault)) {
        const uuid = vaultData.uuid || semester;
        for (const catObj of vaultData.Vault) {
          if (catObj.content && Array.isArray(catObj.content)) {
            for (const topic of catObj.content) {
              index.push({ semester, subject: uuid, subjectDisplay: "Vault", category: catObj.type, topic, url: buildPdfUrl(semester, uuid, topic) });
            }
          }
        }
      }
      continue;
    }
    for (const [subject, categories] of Object.entries(subjects)) {
      if (!Array.isArray(categories)) continue;
      for (const catObj of categories) {
        if (catObj.content && Array.isArray(catObj.content)) {
          for (const topic of catObj.content) {
            index.push({ semester, subject, subjectDisplay: subject, category: catObj.type, topic, url: buildPdfUrl(semester, subject, topic) });
          }
        }
      }
    }
  }
  return index;
}

function matchesQuery(entry, queryWords) {
  const searchText = [`semester ${entry.semester}`, `sem ${entry.semester}`, entry.subjectDisplay, entry.category, entry.topic].join(" ").toLowerCase();
  return queryWords.every(word => searchText.includes(word));
}

// ─── Server Factory ──────────────────────────────────────────────────────────

export function createServer() {
  const server = new McpServer({
    name: "materio-mcp",
    version: "2.1.2"
  });

  // ─── Tool: search (Semantic RAG Vector Search) ───────────────────────
  if (ENABLE_RAG) {
    server.registerTool(
      "search",
      {
        title: "Semantic Vector Search",
        description: `PRIORITY 1 — Semantic search across the pre-indexed Materio document library.

Uses Google Gemini (gemini-embedding-2-preview) to match your question against extracted textbook chunks stored in a vector database.
Always call this first before attempting fetch_pdf. Returns the most relevant text passages with similarity scores and source page references.

Args:
  - query (string): The specific question, concept, or topic to search for. Be precise — e.g. "deadlock detection algorithm" not just "deadlock".
  - semester (string, optional): Filter results to a specific semester (e.g. "4").
  - subject (string, optional): Filter results to a specific subject (e.g. "Operating System").
  - limit (number, optional): Number of results to return (default: 5, max: 15).

Returns:
  Ranked text chunks with similarity %, subject, topic, page range, and a direct PDF link for further reading.

Examples:
  - "Explain banker's algorithm" → params: { query: "banker algorithm deadlock avoidance" }
  - "OS deadlocks semester 4" → params: { query: "deadlock", semester: "4", subject: "Operating System" }`,
        inputSchema: {
          query: z.string().min(1).max(500).describe("The specific question, topic, or concept to semantically search for."),
          semester: z.string().optional().describe("Optional: filter to a specific semester number, e.g. '4'."),
          subject: z.string().optional().describe("Optional: filter to a specific subject name, e.g. 'Operating System'."),
          limit: z.number().int().min(1).max(15).default(5).optional().describe("Number of results to return (default: 5).")
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      async ({ query, semester, subject, limit = 5 }) => {
        try {
          const apiKey = process.env.GOOGLE_API_KEY;
          if (!apiKey) throw new Error("GOOGLE_API_KEY environment variable is not set.");

          // text-embedding-004 with exponential backoff (handles free-tier rate limits)
          let vector;
          const maxRetries = 3;
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            const geminiRes = await fetch(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "models/gemini-embedding-2-preview",
                content: { parts: [{ text: query }] },
                taskType: "RETRIEVAL_QUERY",
                outputDimensionality: 1024
              })
            });

            if (geminiRes.status === 429) {
              if (attempt < maxRetries - 1) {
                await new Promise(r => setTimeout(r, (attempt + 1) * 1500));
                continue;
              }
              throw new Error("Gemini API rate limit exceeded. Please retry in a moment.");
            }
            if (!geminiRes.ok) {
              const errBody = await geminiRes.text();
              throw new Error(`Gemini Embedding API error ${geminiRes.status}: ${errBody}`);
            }
            const geminiData = await geminiRes.json();
            vector = geminiData?.embedding?.values;
            if (!vector || !vector.length) throw new Error("Gemini returned an empty embedding vector.");
            break;
          }

          const { data, error } = await supabase.rpc("match_materio_chunks", {
            query_embedding: vector,
            match_count: limit,
            filter_semester: semester || null,
            filter_subject: subject || null,
            similarity_threshold: 0.25
          });

          if (error) throw error;
          if (!data || data.length === 0) {
            return {
              content: [{
                type: "text",
                text: `No relevant content found in the vector index for: "${query}".\n\nSuggestions:\n- Broaden your search terms\n- Try without semester/subject filters\n- Fall back to get_resource + fetch_pdf`
              }]
            };
          }

          const lines = [`# Semantic Search Results for "${query}"\n`, `Found ${data.length} relevant chunk(s).\n`, "---\n"];
          for (const item of data) {
            const semLabel = item.semester === "9999" ? "Vault" : `Semester ${item.semester}`;
            const pageRef = (item.page_start && item.page_end)
              ? ` (pp. ${item.page_start}–${item.page_end})`
              : item.page_start ? ` (p. ${item.page_start})` : "";
            const pdfRef = item.pdf_url ? `\n  **Source PDF:** ${item.pdf_url}` : "";
            
            // Handle similarity display gracefully
            const rawSim = parseFloat(item.similarity);
            const simScore = isNaN(rawSim) ? 0 : Math.round(rawSim * 100);
            
            lines.push(`### [${simScore}% match] ${item.subject} — ${item.topic}${pageRef}`);
            lines.push(`*${semLabel} · ${item.category || "General"}*${pdfRef}\n`);
            lines.push(item.chunk_text);
            lines.push("\n---\n");
          }

          return { 
            content: [
              { type: "text", text: lines.join("\n") },
              { type: "text", text: JSON.stringify({ results: data.map(d => ({ ...d, embedding: undefined })) }, null, 2) }
            ] 
          };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: `Semantic search error: ${error.message}` }] };
        }
      }
    );
  }

  // ─── Tool: list_resources ────────────────────────────────────────────────
  server.registerTool(
    "list_resources",
    {
      title: "List Materio Resources",
      description: `List all available educational resources in the Materio library.

Returns a structured overview of all semesters, subjects, resource categories, and topics available.
Use this to discover what PDFs are available before fetching a specific one.

Optionally filter by semester number to narrow results.

Args:
  - semester (string, optional): Filter by semester number (e.g. "1", "2", "3", "4", "5", "6"). Omit to list all semesters.

Returns:
  A formatted markdown listing of all available resources organized by semester > subject > category > topics.

Examples:
  - "What subjects are in semester 3?" → params: { semester: "3" }
  - "Show me all resources" → params: {}
  - "What's available for semester 5?" → params: { semester: "5" }`,
    inputSchema: {
        semester: z.string()
            .optional()
            .describe("Filter by semester number, e.g. '1', '2', '3'. Omit to list all.")
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
    }
    },
    async ({ semester }) => {
      try {
        const library = await getResourceLibrary();
        const lines = [];
        const semesterMapping = { "9": "Additional Resources" };
        const semesters = semester ? { [semester]: library[semester] } : library;

        if (semester && !library[semester]) {
          return { content: [{ type: "text", text: `No resources found for semester "${semester}". Available semesters: ${Object.keys(library).join(", ")}` }] };
        }

        lines.push("# Materio Resource Library\n");
        for (const [sem, subjects] of Object.entries(semesters)) {
          if (!subjects) continue;
          const semLabel = semesterMapping[sem] || (sem === "9999" ? "Vault" : `Semester ${sem}`);
          lines.push(`## ${semLabel}\n`);
          
          if (sem === "9999") {
            if (subjects.Vault && Array.isArray(subjects.Vault)) {
              for (const catObj of subjects.Vault) {
                lines.push(`### ${catObj.type}`);
                if (catObj.content) catObj.content.forEach(t => lines.push(`  - ${t}`));
                lines.push("");
              }
            }
            continue;
          }

          for (const [subject, categories] of Object.entries(subjects)) {
            if (!Array.isArray(categories)) continue;
            lines.push(`### ${subject}`);
            for (const catObj of categories) {
              lines.push(`**${catObj.type}:**`);
              if (catObj.content) catObj.content.forEach(t => lines.push(`  - ${t}`));
            }
            lines.push("");
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Error listing resources: ${error.message}` }] };
      }
    }
  );

  // ─── Tool: get_resource (Fuzzy Library Keyword Search) ────────────────────
  server.registerTool(
    "get_resource",
    {
      title: "Search Materio Resources",
      description: `Search across all Materio educational PDFs by keyword.

Searches through semester numbers, subject names, category types (Chapters, Assignments, Question Banks, etc.), and topic names to find matching resources.

Args:
  - query (string): Search keywords to match, e.g. "operating system deadlocks", "maths laplace", "java inheritance", "question bank", "semester 4". Multiple words narrow the search.
  - limit (number, optional): Maximum number of results to return (default: 20, max: 50).

Returns:
  A list of matching resources with semester, subject, category, topic name, and the CDN URL for each PDF.

Examples:
  - "Find notes on deadlocks" → params: { query: "deadlocks" }
  - "Question banks for semester 4" → params: { query: "question bank semester 4" }
  - "Java chapters" → params: { query: "java chapters" }
  - "DBMS SQL" → params: { query: "dbms sql" }
  - "Maths Laplace Transform" → params: { query: "laplace transform" }`,
    inputSchema: {
        query: z.string()
            .min(1, "Search query is required")
            .max(200, "Query too long")
            .describe("Search keywords to match against subjects, topics, and categories"),
        limit: z.number()
            .int()
            .min(1)
            .max(50)
            .default(20)
            .optional()
            .describe("Maximum number of results to return (default: 20)")
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
    }
    },
    async ({ query, limit = 20 }) => {
      try {
        const library = await getResourceLibrary();
        const index = buildSearchIndex(library);
        const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
        
        const results = index.filter(entry => matchesQuery(entry, queryWords));
        const limitedResults = results.slice(0, limit);

        if (limitedResults.length === 0) {
          return {
              content: [{
                  type: "text",
                  text: `No resources found matching "${query}".\n\nTips:\n- Try broader keywords (e.g. "java" instead of "java inheritance chapter 5")\n- Use "list_resources" to browse all available resources\n- Check spelling of subject names`
              }]
          };
        }

        const lines = [`# Search Results for "${query}"\n`];
        lines.push(`Found ${results.length} result(s)${results.length > limit ? ` (showing first ${limit})` : ""}.\n`);

        for (const r of limitedResults) {
            const semLabel = r.semester === "9999" ? "Vault" : `Semester ${r.semester}`;
            const maskedUrl = await generateMaskedUrl(r.url);

            lines.push(`### ${r.topic}`);
            lines.push(`- **Semester:** ${semLabel}`);
            lines.push(`- **Subject:** ${r.subjectDisplay}`);
            lines.push(`- **Category:** ${r.category}`);
            lines.push(`- **PDF Link:** ${maskedUrl}`);
            lines.push("");
        }

        if (results.length > limit) {
            lines.push(`\n> ${results.length - limit} more result(s) not shown. Use a more specific query or increase the limit.`);
        }

        return {
            content: [{ type: "text", text: lines.join("\n") }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Error searching resources: ${error.message}` }] };
      }
    }
  );

  // ─── Tool: fetch_pdf ───────────────────────────────────────────────────────
  server.registerTool(
    "fetch_pdf",
    {
      title: "Get Materio PDF Content",
      description: `Fetch and read the full text content of a Materio PDF.

Downloads the PDF from the Materio CDN and extracts its text content so you can read and reason over it.
Use this after searching/browsing to retrieve the actual study material.

You can provide EITHER a direct PDF URL (from a search result) OR the semester + subject + topic combination.

IMPORTANT: This tool is designed to help users study. When answering questions based on PDF content:
- Use the PDF's own terminology and definitions
- Cover all relevant points as expected in university exams
- Structure answers clearly with proper headings
- Include examples from the material when available

Args:
  - url (string, optional): Direct CDN URL of the PDF. If provided, semester/subject/topic are ignored.
  - semester (string, optional): Semester number (e.g. "1", "2", "3", "4", "5", "6"). Required if url is not provided.
  - subject (string, optional): Subject name exactly as listed in the resource library. Required if url is not provided.
  - topic (string, optional): Topic name exactly as listed in the resource library. Required if url is not provided.

Returns:
  The full extracted text content of the PDF, which may be long. The AI can then use this to answer questions.

Examples:
  - Fetch by URL: { url: "https://cdn-materioa.vercel.app/pdfs/4/Operating%20System/Deadlocks.pdf" }
  - Fetch by path: { semester: "4", subject: "Operating System", topic: "Deadlocks" }
  - Fetch by path: { semester: "3", subject: "Object Oriented Programming with Java", topic: "Inheritance" }`,
    inputSchema: {
        url: z.string()
            .url()
            .optional()
            .describe("Direct CDN URL of the PDF. Takes priority over semester/subject/topic."),
        semester: z.string()
            .optional()
            .describe("Semester number, e.g. '1', '2', '3', '4', '5', '6'."),
        subject: z.string()
            .optional()
            .describe("Subject name exactly as listed in the resource library."),
        topic: z.string()
            .optional()
            .describe("Topic name exactly as listed in the resource library.")
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
    }
    },
    async ({ url, semester, subject, topic }) => {
      try {
        let pdfUrl = url;
        if (!pdfUrl) {
            if (!semester || !subject || !topic) {
                return {
                    isError: true,
                    content: [{
                        type: "text",
                        text: "Error: You must provide either a 'url' or all three of 'semester', 'subject', and 'topic'. Use get_resource to find the correct values."
                    }]
                };
            }
            pdfUrl = buildPdfUrl(semester, subject, topic);
        }

        const text = await fetchPdfText(pdfUrl);

        if (!text || text.trim().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "The PDF was downloaded but no text content could be extracted. It might be a scanned/image-only PDF."
                }]
            };
        }

        let content = text;
        let truncated = false;

        if (content.length > CHARACTER_LIMIT) {
            content = content.substring(0, CHARACTER_LIMIT);
            truncated = true;
        }

        const header = `# PDF Content: ${topic || pdfUrl}\n\n` +
            (truncated ? `> ⚠️ Content truncated to ${CHARACTER_LIMIT} characters. The full PDF is longer.\n\n` : "") +
            `---\n\n`;

        return { content: [{ type: "text", text: header + content }] };
      } catch (error) {
        return {
            isError: true,
            content: [{
                type: "text",
                text: `Error fetching PDF: ${error.message}\n\nPossible fixes:\n- Verify the URL/path is correct using get_resource\n- Check internet connectivity\n- The PDF might not exist at this location`
            }]
        };
      }
    }
  );

  // ─── Tool: share_link ──────────────────────────────────────────────────────
  server.registerTool(
    "share_link",
    {
      title: "Generate Secure Share Link",
      description: `Get a professional masked share link for a Materio PDF.
      
This returns a secure URL (e.g., materias.vercel.app/?share=...) that opens the PDF beautifully in the Materio viewer. Use this when finalizing a study session or providing resources to the user.

Takes EITHER a raw CDN 'url' OR 'semester, subject, topic'.`,
      inputSchema: {
        url: z.string().url().optional().describe("The raw CDN URL to mask"),
        semester: z.string().optional().describe("Semester number (1-6)"),
        subject: z.string().optional().describe("Subject name exactly as listed"),
        topic: z.string().optional().describe("Topic name exactly as listed")
      }
    },
    async ({ url, semester, subject, topic }) => {
      let rawUrl = url;
      if (!rawUrl) rawUrl = buildPdfUrl(semester, subject, topic);
      const maskedUrl = await generateMaskedUrl(rawUrl);
      return { content: [{ type: "text", text: `**Secure Link:** ${maskedUrl}` }] };
    }
  );

  // ─── Tool: subject_overview ────────────────────────────────────────────────
  server.registerTool(
    "subject_overview",
    {
      title: "Get Subject Overview",
      description: `Get a complete overview of all available resources for a specific subject.

Shows all categories (Chapters, Assignments, Question Banks, Previous Year Papers, etc.) and their topics for the given subject. Useful for understanding the full scope of available material before diving into specific topics.

Args:
  - semester (string): Semester number (e.g. "1", "2", "3", "4", "5", "6").
  - subject (string): Subject name exactly as listed in the resource library.

Returns:
  A detailed listing of all resource categories and topics for the subject, with PDF URLs for each.

Examples:
  - { semester: "4", subject: "Operating System" }
  - { semester: "2", subject: "Maths-2" }
  - { semester: "3", subject: "Database Management Systems" }`,
    inputSchema: {
        semester: z.string()
            .min(1, "Semester is required")
            .describe("Semester number, e.g. '1', '2', '3', '4', '5', '6'."),
        subject: z.string()
            .min(1, "Subject is required")
            .describe("Subject name exactly as listed in the resource library.")
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
    }
    },
    async ({ semester, subject }) => {
      try {
          const library = await getResourceLibrary();

          if (!library[semester]) {
              return {
                  isError: true,
                  content: [{
                      type: "text",
                      text: `Semester "${semester}" not found. Available semesters: ${Object.keys(library).join(", ")}`
                  }]
              };
          }

          const semData = library[semester];
          let categories = null;

          if (semester === "9999") {
              categories = semData.Vault;
          } else {
              categories = semData[subject];
              if (!categories) {
                  const subjectKey = Object.keys(semData).find(
                      k => k.toLowerCase() === subject.toLowerCase()
                  );
                  if (subjectKey) {
                      categories = semData[subjectKey];
                      subject = subjectKey;
                  }
              }
          }

          if (!categories || !Array.isArray(categories)) {
              const availableSubjects = Object.keys(semData).filter(k => Array.isArray(semData[k]));
              return {
                  isError: true,
                  content: [{
                      type: "text",
                      text: `Subject "${subject}" not found in semester ${semester}.\n\nAvailable subjects:\n${availableSubjects.map(s => `  - ${s}`).join("\n")}`
                  }]
              };
          }

          const lines = [`# ${subject} — Semester ${semester}\n`];

          let totalTopics = 0;
          for (const catObj of categories) {
              lines.push(`## ${catObj.type}`);
              if (catObj.content && Array.isArray(catObj.content)) {
                  for (const topic of catObj.content) {
                      const rawUrl = buildPdfUrl(semester, subject, topic);
                      const maskedUrl = await generateMaskedUrl(rawUrl);
                      lines.push(`- **${topic}** — [Open PDF](${maskedUrl})`);
                      totalTopics++;
                  }
              }
              lines.push("");
          }

          lines.push(`---\n*Total: ${totalTopics} resources across ${categories.length} categories*`);

          return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
          return {
              isError: true,
              content: [{
                  type: "text",
                  text: `Error fetching subject overview: ${error.message}`
              }]
          };
      }
    }
  );

  // ─── Vercel Serverless Accessibility Polyfills ─────────────────────────────
  function zodToJsonSchema(schema) {
    if (!schema || !schema._def) return { type: "string" };
    const typeName = schema._def.typeName;

    if (typeName === "ZodString") return { type: "string" };
    if (typeName === "ZodNumber") return { type: "number" };
    if (typeName === "ZodBoolean") return { type: "boolean" };
    if (typeName === "ZodOptional" || typeName === "ZodDefault") return zodToJsonSchema(schema._def.innerType || schema._def.type);

    if (typeName === "ZodObject") {
      const shape = typeof schema._def.shape === "function" ? schema._def.shape() : schema._def.shape || {};
      const properties = {};
      const required = [];
      for (const [key, value] of Object.entries(shape)) {
        const valueType = value?._def?.typeName;
        const isOptional = valueType === "ZodOptional" || valueType === "ZodDefault";
        properties[key] = zodToJsonSchema(isOptional ? (value._def.innerType || value._def.type) : value);
        if (value.description && !properties[key].description) properties[key].description = value.description;
        if (!isOptional) required.push(key);
      }
      const out = { type: "object", properties, additionalProperties: false };
      if (required.length > 0) out.required = required;
      return out;
    }
    return { type: "string" };
  }

  server.executeToolManual = async (name, args) => {
    const tool = server._registeredTools[name];
    if (!tool) throw new Error(`Tool "${name}" not found`);
    return await tool.handler(args);
  };

  server.listToolsManual = async () => {
    const tools = [];
    for (const [name, tool] of Object.entries(server._registeredTools)) {
      tools.push({
        name,
        title: tool.title || name,
        description: tool.description,
        inputSchema: tool.inputSchema?._def ? zodToJsonSchema(tool.inputSchema) : { type: "object", properties: {}, additionalProperties: false }
      });
    }
    return { tools };
  };

  return server;
}

// ─── Local Execution Only ────────────────────────────────────────────────────
const isMainModule = typeof process !== "undefined" && process.argv && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const app = express();
  app.get("/favicon.ico", (req, res) => {
    const img = Buffer.from(FAVICON_BASE64.split(",")[1], 'base64');
    res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Content-Length': img.length });
    res.end(img);
  });
  app.listen(3000, () => console.error("Identity/Favicon service active on port 3000"));

  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error("Materio MCP active via STDIO");
  });
}
