/**
 * Materio MCP Server — Shared Core
 * 
 * Contains all tool registrations and shared utilities.
 * Used by both the local stdio entry point (index.js) and
 * the Vercel serverless HTTP entry point (api/mcp.js).
 * 
 * © 2024-2026, Materio by JTC.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ─── Constants ───────────────────────────────────────────────────────────────

const CDN_BASE = "https://cdn-materioa.vercel.app";
const RESOURCE_LIB_URL = `${CDN_BASE}/databases/beta/resource.lib.json`;
const CHARACTER_LIMIT = 80000; // Max chars to return from a PDF

// ─── Resource Library Cache ─────────────────────────────────────────────────

let resourceLibCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Generates a masked share URL for a given PDF CDN URL by calling the Materio Share API.
 * This hides the actual CDN path and uses the site's /?share=XXXX format.
 */
async function generateMaskedUrl(actualUrl) {
  try {
    // We use the 'create' subAction which is specifically for the /?share= format
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
  } catch (err) {
    console.error("Masking error:", err.message);
  }
  return actualUrl; // Fallback to raw CDN URL
}

/**
 * Fetches and caches the resource library JSON from the CDN.
 */
async function getResourceLibrary() {
  const now = Date.now();
  if (resourceLibCache && (now - cacheTimestamp) < CACHE_TTL) {
    return resourceLibCache;
  }

  try {
    const response = await fetch(RESOURCE_LIB_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch resource library: HTTP ${response.status}`);
    }
    resourceLibCache = await response.json();
    cacheTimestamp = now;
    return resourceLibCache;
  } catch (error) {
    if (resourceLibCache) {
      return resourceLibCache;
    }
    throw error;
  }
}

/**
 * Builds the CDN URL for a given PDF.
 * Uses raw names to match the frontend and share API expectations.
 */
function buildPdfUrl(semester, subject, topic) {
  if (semester === "9999") {
    return `${CDN_BASE}/pdfs/${semester}/${subject}/vault/${topic}.pdf`;
  }
  return `${CDN_BASE}/pdfs/${semester}/${subject}/${topic}.pdf`;
}

/**
 * Fetches a PDF from the CDN and extracts its text content.
 */
async function fetchPdfText(url) {
  // We MUST encode for the actual HTTP fetch, as some platforms/libraries 
  // don't handle raw spaces in URLs.
  const encodedUrl = new URL(url).toString();
  const response = await fetch(encodedUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF: HTTP ${response.status} from ${url}`);
  }

  const buffer = await response.arrayBuffer();
  const uint8 = new Uint8Array(buffer);

  const pdfParse = (await import("pdf-parse")).default;
  const data = await pdfParse(Buffer.from(uint8));

  return data.text;
}

/**
 * Builds a flat searchable index from the resource library.
 */
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
              index.push({
                semester,
                subject: uuid,
                subjectDisplay: "Vault",
                category: catObj.type,
                topic,
                url: buildPdfUrl(semester, uuid, topic)
              });
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
            index.push({
              semester,
              subject,
              subjectDisplay: subject,
              category: catObj.type,
              topic,
              url: buildPdfUrl(semester, subject, topic)
            });
          }
        }
      }
    }
  }

  return index;
}

/**
 * Fuzzy-ish search: checks if all query words appear somewhere
 * in the combined searchable text (case-insensitive).
 */
function matchesQuery(entry, queryWords) {
  const searchText = [
    `semester ${entry.semester}`,
    `sem ${entry.semester}`,
    entry.subjectDisplay,
    entry.category,
    entry.topic
  ].join(" ").toLowerCase();

  return queryWords.every(word => searchText.includes(word));
}

// ─── Server Factory ──────────────────────────────────────────────────────────

/**
 * Creates and returns a fully configured McpServer with all Materio tools registered.
 */
export function createServer() {
  const server = new McpServer({
    name: "materio-mcp-server",
    version: "1.0.0"
  });

  // ─── Tool: materio_list_resources ──────────────────────────────────────────

  server.registerTool(
    "materio_list_resources",
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
          return {
            content: [{
              type: "text",
              text: `No resources found for semester "${semester}". Available semesters: ${Object.keys(library).join(", ")}`
            }]
          };
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
                if (catObj.content) {
                  catObj.content.forEach(t => lines.push(`  - ${t}`));
                }
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
              if (catObj.content) {
                catObj.content.forEach(t => lines.push(`  - ${t}`));
              }
            }
            lines.push("");
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Error listing resources: ${error.message}. Make sure you have internet connectivity.`
          }]
        };
      }
    }
  );

  // ─── Tool: materio_search ──────────────────────────────────────────────────

  server.registerTool(
    "materio_search",
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
              text: `No resources found matching "${query}".\n\nTips:\n- Try broader keywords (e.g. "java" instead of "java inheritance chapter 5")\n- Use "materio_list_resources" to browse all available resources\n- Check spelling of subject names`
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
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Error searching resources: ${error.message}`
          }]
        };
      }
    }
  );

  // ─── Tool: materio_get_pdf ─────────────────────────────────────────────────

  server.registerTool(
    "materio_get_pdf",
    {
      title: "Get Materio PDF Content",
      description: `Fetch and read the full text content of a Materio PDF.

Downloads the PDF from the Materio CDN and extracts its text content so you can read and reason over it.
Use this after searching/browsing to retrieve the actual study material.

**Syllabus Fallback Strategy:**
If this tool returns an "unreadable" error, you MUST immediately use 'materio_get_subject_overview' to find the 'Syllabus' or 'Course Overview' PDF URL and read that instead to understand the curriculum.

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
                text: "Error: You must provide either a 'url' or all three of 'semester', 'subject', and 'topic'. Use materio_search to find the correct values."
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
              text: `The PDF content is unreadable (likely a scanned image). 

**Recommendation:** Please use the \`materio_get_subject_overview\` tool to find the **Syllabus** or **Course Overview** PDF instead. I can use that and my knowledge to assist you.`
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

        return {
          content: [{ type: "text", text: header + content }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Error fetching PDF: ${error.message}\n\nPossible fixes:\n- Verify the URL/path is correct using materio_search\n- Check internet connectivity\n- The PDF might not exist at this location`
          }]
        };
      }
    }
  );

  // ─── Tool: materio_get_pdf_url ─────────────────────────────────────────────

  server.registerTool(
    "materio_get_pdf_url",
    {
      title: "Get Secure Materio Share Link",
      description: `Get a professional masked share link for a Materio PDF.
      
This returns a secure URL (e.g., materias.vercel.app/?share=...) that opens the PDF beautifully in the Materio viewer. 

**Usage Instructions:**
- Use this when finalizing a study session.
- If the original PDF was scanned/unreadable, use this tool to provide the share link for the **Syllabus** instead so the user can verify the curriculum manually.`,
      inputSchema: {
        semester: z.string().describe("Semester number (1-6)"),
        subject: z.string().describe("Subject name exactly as listed"),
        topic: z.string().describe("Topic name exactly as listed")
      }
    },
    async ({ semester, subject, topic }) => {
      const rawUrl = buildPdfUrl(semester, subject, topic);
      const maskedUrl = await generateMaskedUrl(rawUrl);
      return {
        content: [{ type: "text", text: `**Materio Share Link:** ${maskedUrl}` }]
      };
    }
  );

  // ─── Tool: materio_get_share_link ──────────────────────────────────────────

  server.registerTool(
    "materio_get_share_link",
    {
      title: "Generate Share Link",
      description: "Generate a secure masked Materio share link from a raw CDN URL.",
      inputSchema: {
        url: z.string().url().describe("The raw CDN URL to mask")
      }
    },
    async ({ url }) => {
      const maskedUrl = await generateMaskedUrl(url);
      return {
        content: [{ type: "text", text: `**Secure Link:** ${maskedUrl}` }]
      };
    }
  );

  // ─── Tool: materio_get_subject_overview ────────────────────────────────────

  server.registerTool(
    "materio_get_subject_overview",
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

        return {
          content: [{ type: "text", text: lines.join("\n") }]
        };
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

  // ─── Tool: materio_get_subject_overview ────────────────────────────────────
  // ... (existing tool registrations) ...

  // Convert Zod schemas to plain JSON Schema so remote clients can render tools.
  function zodToJsonSchema(schema) {
    if (!schema || !schema._def) {
      return { type: "string" };
    }

    const typeName = schema._def.typeName;

    if (typeName === "ZodString") {
      const out = { type: "string" };
      if (schema.description) out.description = schema.description;
      return out;
    }

    if (typeName === "ZodNumber") {
      const out = { type: "number" };
      if (schema.description) out.description = schema.description;
      return out;
    }

    if (typeName === "ZodBoolean") {
      const out = { type: "boolean" };
      if (schema.description) out.description = schema.description;
      return out;
    }

    if (typeName === "ZodOptional" || typeName === "ZodDefault") {
      return zodToJsonSchema(schema._def.innerType || schema._def.type);
    }

    if (typeName === "ZodObject") {
      const shape = typeof schema._def.shape === "function"
        ? schema._def.shape()
        : schema._def.shape || {};

      const properties = {};
      const required = [];

      for (const [key, value] of Object.entries(shape)) {
        const valueType = value?._def?.typeName;
        const isOptional = valueType === "ZodOptional" || valueType === "ZodDefault";
        const baseSchema = isOptional ? (value._def.innerType || value._def.type) : value;

        properties[key] = zodToJsonSchema(baseSchema);
        if (value?.description && !properties[key].description) {
          properties[key].description = value.description;
        }

        if (!isOptional) required.push(key);
      }

      const out = {
        type: "object",
        properties,
        additionalProperties: false,
      };
      if (required.length > 0) out.required = required;
      return out;
    }

    return { type: "string" };
  }

  // 🛡️ Accessibility: Manual methods for non-MCP-native clients (like ChatGPT/Remote Bridge)
  server.executeToolManual = async (name, args) => {
    const tool = server._registeredTools[name];
    if (!tool) throw new Error(`Tool "${name}" not found`);
    return await tool.handler(args);
  };

  server.listToolsManual = async () => {
    const tools = [];
    for (const [name, tool] of Object.entries(server._registeredTools)) {
      const inputSchema = tool.inputSchema?._def
        ? zodToJsonSchema(tool.inputSchema)
        : (tool.inputSchema || { type: "object", properties: {}, additionalProperties: false });

      tools.push({
        name,
        title: tool.title,
        description: tool.description,
        inputSchema
      });
    }
    return { tools };
  };

  return server;
}
