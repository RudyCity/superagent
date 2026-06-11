import { Tool } from "./types.js";

function htmlToMarkdown(html: string): string {
  let md = html;
  
  // Remove script, style, head, nav, footer, iframe, noscript tags and content
  md = md.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  md = md.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  md = md.replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, "");
  md = md.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "");
  md = md.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "");
  md = md.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "");
  md = md.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");
  md = md.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "");
  
  // Replace headings
  md = md.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  md = md.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  md = md.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  md = md.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  
  // Replace links: <a href="url">text</a> -> [text](url)
  md = md.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (match, url, text) => {
    const cleanText = text.replace(/<[^>]+>/g, "").trim();
    return cleanText ? `[${cleanText}](${url})` : "";
  });
  
  // Replace list items
  md = md.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n* $1");
  
  // Replace paragraphs and line breaks
  md = md.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");
  
  // Strip all other HTML tags
  md = md.replace(/<[^>]+>/g, " ");
  
  // Decode HTML entities
  md = md.replace(/&nbsp;/g, " ")
         .replace(/&amp;/g, "&")
         .replace(/&lt;/g, "<")
         .replace(/&gt;/g, ">")
         .replace(/&quot;/g, '"')
         .replace(/&#39;/g, "'");
         
  // Normalize spacing and newlines
  md = md.replace(/[ \t]+/g, " ");
  md = md.replace(/\n\s*\n\s*\n+/g, "\n\n");
  
  return md.trim();
}

export const webSearchTool: Tool = {
  name: "web_search",
  description: "Search the web using DuckDuckGo HTML search.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
    },
    required: ["query"],
  },
  async execute(args, cwd, signal) {
    const query = args.query as string;
    try {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal,
      });
      if (!response.ok) {
        return `Search failed with status ${response.status}`;
      }
      const html = await response.text();
      const results: string[] = [];
      const resultBlockRegex = /<div class="result[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g;
      let match;
      let count = 0;
      while ((match = resultBlockRegex.exec(html)) !== null && count < 5) {
        const block = match[1];
        const titleMatch = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block) || /<a class="result__url"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        const snippetMatch = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block) || /<div class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
        const urlMatch = /<a class="result__url"[^>]*href="([^"]*)"/i.exec(block) || /<a class="result__snippet"[^>]*href="([^"]*)"/i.exec(block);

        let title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : "";
        let snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";
        let url = urlMatch ? urlMatch[1] : "";

        if (url.startsWith("//")) {
          url = "https:" + url;
        }
        if (url.includes("uddg=")) {
          const matchUddg = /uddg=([^&]+)/.exec(url);
          if (matchUddg) {
            url = decodeURIComponent(matchUddg[1]);
          }
        }

        if (title || snippet) {
          results.push(`Title: ${title}\nURL: ${url}\nSnippet: ${snippet}`);
          count++;
        }
      }

      if (results.length === 0) {
        // Fallback A: search for linkRegex
        const linkRegex = /<a href="([^"]+)"[^>]*class="result__url"[^>]*>([^<]+)<\/a>/g;
        while ((match = linkRegex.exec(html)) !== null && count < 5) {
          let url = match[1];
          if (url.includes("uddg=")) {
            const matchUddg = /uddg=([^&]+)/.exec(url);
            if (matchUddg) url = decodeURIComponent(matchUddg[1]);
          }
          results.push(`URL: ${url}`);
          count++;
        }
      }

      if (results.length === 0) {
        // Fallback B: search for any anchor tags with result links
        const fallbackRegex = /<a[^>]*href="([^"]*)"[^>]*class="[^"]*result__url[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((match = fallbackRegex.exec(html)) !== null && count < 5) {
          let url = match[1];
          let title = match[2].replace(/<[^>]*>/g, "").trim();
          if (url.includes("uddg=")) {
            const matchUddg = /uddg=([^&]+)/.exec(url);
            if (matchUddg) url = decodeURIComponent(matchUddg[1]);
          }
          results.push(`Title: ${title}\nURL: ${url}`);
          count++;
        }
      }

      return results.length > 0 ? results.join("\n\n") : "No results found.";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Search error: ${message}`;
    }
  },
};

export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description: "Fetch content from a URL and return a clean text representation.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch",
      },
    },
    required: ["url"],
  },
  async execute(args, cwd, signal) {
    const url = args.url as string;
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal,
      });
      if (!response.ok) {
        return `Failed to fetch URL. Status: ${response.status}`;
      }

      const contentType = response.headers?.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await response.json();
        return JSON.stringify(json, null, 2);
      }

      const rawHtml = await response.text();
      let clean = htmlToMarkdown(rawHtml);

      if (clean.length > 8000) {
        clean = clean.slice(0, 8000) + "\n\n... (content truncated)";
      }

      return clean || "(empty content)";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Fetch error: ${message}`;
    }
  },
};
