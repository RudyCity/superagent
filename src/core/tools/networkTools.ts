import { Tool } from "./types.js";

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
      const rawHtml = await response.text();
      let clean = rawHtml
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

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
