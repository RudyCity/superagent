import { Tool } from "./types.js";
import { webSearchTool } from "./networkTools.js";
import { mutateModelConfig, loadModelConfig } from "../config/jsonConfig.js";

// Helper to decode XML/HTML entities
function decodeEntities(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Helper to clean HTML to markdown
function cleanHtml(html: string): string {
  const noTags = html.replace(/<[^>]*>/g, "");
  return decodeEntities(noTags).replace(/\s+/g, " ").trim();
}

// Helper to parse XML tag safely
function parseXmlTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i");
  const match = regex.exec(xml);
  return match ? match[1] : "";
}

// Interfaces
interface JournalResult {
  source: string;
  title: string;
  authors: string;
  year: string;
  urlOrDoi: string;
  description?: string;
}

export const searchJournalTool: Tool = {
  name: "search_journal",
  description: "Search academic journals using Semantic Scholar, ArXiv, OpenAlex, Crossref, and CORE APIs, with fallback to Google/DuckDuckGo.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Academic search query",
      },
      provider: {
        type: "string",
        description: "Preferred academic engine: openalex, arxiv, semanticscholar, crossref, core, or auto",
        enum: ["openalex", "arxiv", "semanticscholar", "crossref", "core", "auto"],
        default: "auto",
      },
      limit: {
        type: "number",
        description: "Maximum number of search results to return (default is 5)",
        default: 5,
      },
    },
    required: ["query"],
  },
  async execute(args, cwd, signal) {
    const query = args.query as string;
    const provider = (args.provider as string) || "auto";
    const limit = typeof args.limit === "number" ? args.limit : 5;

    // Load existing configs
    const config = loadModelConfig();
    let semanticScholarKey = (config as any).semanticScholarKey || "";
    let coreKey = (config as any).coreKey || "";

    // Ask user for API Key if they request a provider that needs it
    if (provider === "semanticscholar" && !semanticScholarKey) {
      const { askQuestionTool } = await import("./interactionTools.js");
      const answer = await askQuestionTool.execute({
        question: "Semantic Scholar API Key is not configured. Would you like to provide one?",
        options: ["No, run without key (rate-limited)", "Yes, enter key now"],
      }, cwd, signal);

      if (answer === "Yes, enter key now") {
        const keyAnswer = await askQuestionTool.execute({
          question: "Enter your Semantic Scholar API Key:",
          options: [],
        }, cwd, signal);
        if (keyAnswer && typeof keyAnswer === "string") {
          semanticScholarKey = keyAnswer.trim();
          mutateModelConfig((cfg: any) => {
            cfg.semanticScholarKey = semanticScholarKey;
          });
        }
      }
    }

    if (provider === "core" && !coreKey) {
      const { askQuestionTool } = await import("./interactionTools.js");
      const answer = await askQuestionTool.execute({
        question: "CORE API Key is not configured. CORE requires an API key to search. Enter one?",
        options: ["No, skip CORE", "Yes, enter key now"],
      }, cwd, signal);

      if (answer === "Yes, enter key now") {
        const keyAnswer = await askQuestionTool.execute({
          question: "Enter your CORE API Key:",
          options: [],
        }, cwd, signal);
        if (keyAnswer && typeof keyAnswer === "string") {
          coreKey = keyAnswer.trim();
          mutateModelConfig((cfg: any) => {
            cfg.coreKey = coreKey;
          });
        }
      }
    }

    // Individual Provider Fetching Functions
    const fetchOpenAlex = async (): Promise<JournalResult[]> => {
      const res = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&limit=${limit}`, {
        headers: { "User-Agent": "Superagent/1.0 (mailto:info@superagent.ai)" },
        signal
      });
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        throw new Error(`OpenAlex Rate Limited. Retry after: ${retryAfter || "unknown"}s`);
      }
      if (!res.ok) throw new Error(`OpenAlex search failed with status ${res.status}`);
      const data = await res.json();
      return (data.results || []).map((item: any) => ({
        source: "OpenAlex",
        title: cleanHtml(item.title || "Untitled"),
        authors: (item.authorships || []).map((a: any) => a.author?.display_name).filter(Boolean).slice(0, 3).join(", ") || "Unknown",
        year: String(item.publication_year || "N/A"),
        urlOrDoi: item.doi || item.id || "N/A"
      }));
    };

    const fetchArXiv = async (): Promise<JournalResult[]> => {
      const res = await fetch(`http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}`, { signal });
      if (res.status === 429) {
        throw new Error("ArXiv Rate Limited.");
      }
      if (!res.ok) throw new Error(`ArXiv search failed with status ${res.status}`);
      const text = await res.text();
      const results: JournalResult[] = [];
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
      let match;
      while ((match = entryRegex.exec(text)) !== null) {
        const entryStr = match[1];
        const title = cleanHtml(parseXmlTag(entryStr, "title"));
        const summary = cleanHtml(parseXmlTag(entryStr, "summary"));
        const id = cleanHtml(parseXmlTag(entryStr, "id"));
        const authors: string[] = [];
        const authorRegex = /<author>([\s\S]*?)<\/author>/g;
        let authMatch;
        while ((authMatch = authorRegex.exec(entryStr)) !== null) {
          const name = cleanHtml(parseXmlTag(authMatch[1], "name"));
          if (name) authors.push(name);
        }
        results.push({
          source: "ArXiv",
          title,
          authors: authors.slice(0, 3).join(", ") || "Unknown",
          year: "N/A",
          urlOrDoi: id,
          description: summary.slice(0, 200) + (summary.length > 200 ? "..." : "")
        });
      }
      return results;
    };

    const fetchSemanticScholar = async (): Promise<JournalResult[]> => {
      const headers: Record<string, string> = {};
      if (semanticScholarKey) {
        headers["x-api-key"] = semanticScholarKey;
      }
      const res = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,authors,year,url,abstract`, {
        headers,
        signal
      });
      if (res.status === 429) {
        throw new Error("Semantic Scholar Rate Limited.");
      }
      if (!res.ok) throw new Error(`Semantic Scholar failed with status ${res.status}`);
      const data = await res.json();
      return (data.data || []).map((item: any) => ({
        source: "Semantic Scholar",
        title: cleanHtml(item.title || "Untitled"),
        authors: (item.authors || []).map((a: any) => a.name).join(", ") || "Unknown",
        year: String(item.year || "N/A"),
        urlOrDoi: item.url || "N/A",
        description: item.abstract ? cleanHtml(item.abstract).slice(0, 200) + "..." : undefined
      }));
    };

    const fetchCrossref = async (): Promise<JournalResult[]> => {
      const res = await fetch(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}`, { signal });
      if (res.status === 429) {
        throw new Error("Crossref Rate Limited.");
      }
      if (!res.ok) throw new Error(`Crossref search failed with status ${res.status}`);
      const data = await res.json();
      return (data.message?.items || []).map((item: any) => ({
        source: "Crossref",
        title: cleanHtml((item.title || []).join(" ") || "Untitled"),
        authors: (item.author || []).map((a: any) => `${a.given || ""} ${a.family || ""}`.trim()).join(", ") || "Unknown",
        year: item.created && item.created["date-parts"] ? String(item.created["date-parts"][0][0]) : "N/A",
        urlOrDoi: item.DOI ? `https://doi.org/${item.DOI}` : "N/A"
      }));
    };

    const fetchCore = async (): Promise<JournalResult[]> => {
      if (!coreKey) return [];
      const res = await fetch(`https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(query)}&limit=${limit}`, {
        headers: { "Authorization": `Bearer ${coreKey}` },
        signal
      });
      if (res.status === 429) {
        throw new Error("CORE Rate Limited.");
      }
      if (!res.ok) throw new Error(`CORE failed with status ${res.status}`);
      const data = await res.json();
      return (data.results || []).map((item: any) => ({
        source: "CORE",
        title: cleanHtml(item.title || "Untitled"),
        authors: (item.authors || []).map((a: any) => a.name).join(", ") || "Unknown",
        year: String(item.yearPublished || "N/A"),
        urlOrDoi: item.downloadUrl || "N/A"
      }));
    };

    const finalResults: JournalResult[] = [];
    const errors: string[] = [];

    // Parallel execution for auto mode or target selection
    if (provider === "auto") {
      const tasks = [
        fetchOpenAlex().catch(e => { errors.push(e.message); return []; }),
        fetchArXiv().catch(e => { errors.push(e.message); return []; }),
        fetchSemanticScholar().catch(e => { errors.push(e.message); return []; }),
        fetchCrossref().catch(e => { errors.push(e.message); return []; }),
        ...(coreKey ? [fetchCore().catch(e => { errors.push(e.message); return []; })] : [])
      ];

      const resolved = await Promise.all(tasks);
      for (const list of resolved) {
        finalResults.push(...list);
      }
    } else {
      try {
        let list: JournalResult[] = [];
        if (provider === "openalex") list = await fetchOpenAlex();
        else if (provider === "arxiv") list = await fetchArXiv();
        else if (provider === "semanticscholar") list = await fetchSemanticScholar();
        else if (provider === "crossref") list = await fetchCrossref();
        else if (provider === "core") list = await fetchCore();
        finalResults.push(...list);
      } catch (e: any) {
        errors.push(e.message);
      }
    }

    // Formatting Results
    const formatted: string[] = [];
    if (errors.length > 0) {
      formatted.push(`Warnings/Errors encountered:\n- ${errors.join("\n- ")}`);
    }

    if (finalResults.length > 0) {
      // Group results by source
      const grouped: Record<string, JournalResult[]> = {};
      for (const res of finalResults) {
        if (!grouped[res.source]) grouped[res.source] = [];
        grouped[res.source].push(res);
      }

      for (const [source, list] of Object.entries(grouped)) {
        formatted.push(`--- ${source} Results ---`);
        for (const item of list) {
          let str = `Title: ${item.title}\nAuthors: ${item.authors}\nYear: ${item.year}\nLink/DOI: ${item.urlOrDoi}`;
          if (item.description) {
            str += `\nSummary: ${item.description}`;
          }
          formatted.push(str);
        }
      }
    }

    // FALLBACK to DuckDuckGo Web Search if no results found
    if (finalResults.length === 0) {
      formatted.push("No academic journal results found. Falling back to general web search...");
      const fallbackQuery = `${query} academic journal paper`;
      try {
        const webRes = await webSearchTool.execute({ query: fallbackQuery }, cwd, signal);
        formatted.push(String(webRes));
      } catch (e: any) {
        formatted.push(`Fallback Web Search Error: ${e.message}`);
      }
    }

    return formatted.join("\n\n");
  }
};
