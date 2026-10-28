/**
 * Google Workspace-aware read helpers for Chrome CDP.
 *
 * These helpers intentionally prefer structured browser-accessible surfaces
 * (preview/htmlview/htmlpresent, same-origin frames, accessibility data) over
 * OCR or vision.
 */

export type GoogleWorkspaceApp = "docs" | "sheets" | "slides" | "drive" | "forms" | "unknown";

export interface WorkspaceReadRoute {
  app: GoogleWorkspaceApp;
  source: string;
  url: string;
}

export type WorkspaceFailureReason =
  | "login_required"
  | "access_denied"
  | "permission_request"
  | "file_not_found"
  | "google_error"
  | "redirected"
  | "timeout"
  | "iframe_timeout"
  | "target_closed"
  | "network_failure";

export interface WorkspaceFailureDetection {
  failed: boolean;
  reason?: WorkspaceFailureReason;
  message?: string;
  url?: string;
  title?: string;
}

export type ScopeStatus = "verified" | "partial" | "unknown" | "unavailable" | "not_read" | "none_found";

export interface DocsVerificationScopes {
  text_content: ScopeStatus;
  block_order: ScopeStatus;
  image_order: ScopeStatus;
  image_anchor: ScopeStatus;
  image_binary: ScopeStatus;
  tables: ScopeStatus;
  headings: ScopeStatus;
  lists: ScopeStatus;
  captions: ScopeStatus;
  comments: ScopeStatus;
  suggestions: ScopeStatus;
  drawings: ScopeStatus;
  footnotes: ScopeStatus;
  document_tabs: ScopeStatus;
  images?: ScopeStatus;
}

export type DocsBlockType =
  | "heading"
  | "paragraph"
  | "list_item"
  | "image"
  | "table"
  | "divider";

export interface DocsBaseBlock {
  id: string;
  index: number;
  type: DocsBlockType;
}

export interface DocsHeadingBlock extends DocsBaseBlock {
  type: "heading";
  text: string;
  level: number;
}

export interface DocsParagraphBlock extends DocsBaseBlock {
  type: "paragraph";
  text: string;
}

export interface DocsListItemBlock extends DocsBaseBlock {
  type: "list_item";
  text: string;
  listType?: "bullet" | "ordered";
  level?: number;
}

export type DocsImagePlacement = "inline" | "anchored" | "floating" | "unknown";

export interface DocsImageDimensions {
  width?: number;
  height?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  aspectRatio?: number;
}

export interface DocsImageBinaryReference {
  type: "url" | "blob_url" | "data_uri" | "export_ref" | "unknown";
  url?: string;
  recoverable: boolean;
}

export interface DocsImageBlock extends DocsBaseBlock {
  type: "image";
  src?: string;
  alt?: string;
  title?: string;
  caption?: string;
  placement: DocsImagePlacement;
  anchorBlockId?: string;
  anchorType?: "inline_with_text" | "wrap_text" | "break_text" | "behind_text" | "in_front_of_text" | "unknown";
  dimensions?: DocsImageDimensions;
  binaryReference?: DocsImageBinaryReference;
}

export interface DocsTableRow {
  index: number;
  cells: Array<{
    index: number;
    text: string;
    rowspan?: number;
    colspan?: number;
  }>;
}

export interface DocsTableBlock extends DocsBaseBlock {
  type: "table";
  rows: DocsTableRow[];
  totalRows: number;
  totalCols: number;
}

export interface DocsDividerBlock extends DocsBaseBlock {
  type: "divider";
}

export type DocsContentBlock =
  | DocsHeadingBlock
  | DocsParagraphBlock
  | DocsListItemBlock
  | DocsImageBlock
  | DocsTableBlock
  | DocsDividerBlock;

export interface DocsImageManifestItem {
  blockId: string;
  blockIndex: number;
  alt?: string;
  title?: string;
  caption?: string;
  src?: string;
  placement: DocsImagePlacement;
  anchorBlockId?: string;
  anchorType?: string;
  binaryReference?: DocsImageBinaryReference;
  dimensions?: DocsImageDimensions;
  wpAttachmentId?: number | string;
  wpAttachmentUrl?: string;
  wpBlockMarkup?: string;
}

export interface DocsRenderingContract {
  version: "1.0";
  sourceKind: "google_docs";
  documentTitle: string;
  totalBlocks: number;
  blocks: DocsContentBlock[];
  verificationScopes: DocsVerificationScopes;
  imageManifest: DocsImageManifestItem[];
}

export interface WordPressBlockReplacement {
  blockId: string;
  wpAttachmentId?: number | string;
  wpAttachmentUrl?: string;
  wpBlockMarkup?: string;
  caption?: string;
  alt?: string;
}

function escapeHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildDocsRenderingContract(
  docTitle: string,
  blocks: DocsContentBlock[],
  scopes: DocsVerificationScopes
): DocsRenderingContract {
  const sorted = [...blocks].sort((a, b) => a.index - b.index);
  const imageManifest: DocsImageManifestItem[] = [];

  for (const b of sorted) {
    if (b.type === "image") {
      imageManifest.push({
        blockId: b.id,
        blockIndex: b.index,
        alt: b.alt,
        title: b.title,
        caption: b.caption,
        src: b.src,
        placement: b.placement,
        anchorBlockId: b.anchorBlockId,
        anchorType: b.anchorType,
        binaryReference: b.binaryReference,
        dimensions: b.dimensions,
      });
    }
  }

  return {
    version: "1.0",
    sourceKind: "google_docs",
    documentTitle: docTitle || "Google Doc",
    totalBlocks: sorted.length,
    blocks: sorted,
    verificationScopes: scopes,
    imageManifest,
  };
}

export function renderBlocksToHtml(
  contract: DocsRenderingContract,
  replacements?: Map<string, WordPressBlockReplacement> | Record<string, WordPressBlockReplacement>
): string {
  const getReplacement = (id: string): WordPressBlockReplacement | undefined => {
    if (!replacements) return undefined;
    if (replacements instanceof Map) return replacements.get(id);
    return replacements[id];
  };

  const htmlParts: string[] = [];
  for (const block of contract.blocks) {
    switch (block.type) {
      case "heading": {
        const lvl = Math.max(1, Math.min(6, block.level || 1));
        htmlParts.push(`<h${lvl}>${escapeHtml(block.text)}</h${lvl}>`);
        break;
      }
      case "paragraph": {
        htmlParts.push(`<p>${escapeHtml(block.text)}</p>`);
        break;
      }
      case "list_item": {
        const tag = block.listType === "ordered" ? "ol" : "ul";
        htmlParts.push(`<${tag}><li>${escapeHtml(block.text)}</li></${tag}>`);
        break;
      }
      case "image": {
        const rep = getReplacement(block.id);
        if (rep && rep.wpBlockMarkup) {
          htmlParts.push(rep.wpBlockMarkup.trim());
        } else {
          const src = rep?.wpAttachmentUrl || block.src || "";
          const alt = rep?.alt !== undefined ? rep.alt : (block.alt || "");
          const caption = rep?.caption !== undefined ? rep.caption : (block.caption || "");
          let figure = `<figure class="wp-block-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
          if (caption) {
            figure += `<figcaption>${escapeHtml(caption)}</figcaption>`;
          }
          figure += `</figure>`;
          htmlParts.push(figure);
        }
        break;
      }
      case "table": {
        let tableHtml = `<table><tbody>`;
        for (const row of block.rows) {
          tableHtml += `<tr>`;
          for (const cell of row.cells) {
            const colspan = cell.colspan && cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "";
            const rowspan = cell.rowspan && cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "";
            tableHtml += `<td${colspan}${rowspan}>${escapeHtml(cell.text)}</td>`;
          }
          tableHtml += `</tr>`;
        }
        tableHtml += `</tbody></table>`;
        htmlParts.push(tableHtml);
        break;
      }
      case "divider": {
        htmlParts.push(`<hr />`);
        break;
      }
    }
  }

  return htmlParts.join("\n\n");
}

export function renderBlocksToWordPressMarkup(
  contract: DocsRenderingContract,
  replacements?: Map<string, WordPressBlockReplacement> | Record<string, WordPressBlockReplacement>
): string {
  const getReplacement = (id: string): WordPressBlockReplacement | undefined => {
    if (!replacements) return undefined;
    if (replacements instanceof Map) return replacements.get(id);
    return replacements[id];
  };

  const wpParts: string[] = [];
  for (const block of contract.blocks) {
    switch (block.type) {
      case "heading": {
        const lvl = Math.max(1, Math.min(6, block.level || 1));
        wpParts.push(`<!-- wp:heading {"level":${lvl}} -->\n<h${lvl}>${escapeHtml(block.text)}</h${lvl}>\n<!-- /wp:heading -->`);
        break;
      }
      case "paragraph": {
        wpParts.push(`<!-- wp:paragraph -->\n<p>${escapeHtml(block.text)}</p>\n<!-- /wp:paragraph -->`);
        break;
      }
      case "list_item": {
        const ordered = block.listType === "ordered";
        const tag = ordered ? "ol" : "ul";
        wpParts.push(`<!-- wp:list ${ordered ? '{"ordered":true}' : ''} -->\n<${tag}><li>${escapeHtml(block.text)}</li></${tag}>\n<!-- /wp:list -->`);
        break;
      }
      case "image": {
        const rep = getReplacement(block.id);
        if (rep && rep.wpBlockMarkup) {
          wpParts.push(rep.wpBlockMarkup.trim());
        } else {
          const src = rep?.wpAttachmentUrl || block.src || "";
          const alt = rep?.alt !== undefined ? rep.alt : (block.alt || "");
          const caption = rep?.caption !== undefined ? rep.caption : (block.caption || "");
          const attId = rep?.wpAttachmentId;
          const jsonMeta = attId ? `{"id":${JSON.stringify(attId)},"sizeSlug":"large","linkDestination":"none"}` : `{}`;
          let imgBlock = `<!-- wp:image ${jsonMeta} -->\n<figure class="wp-block-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
          if (caption) {
            imgBlock += `<figcaption>${escapeHtml(caption)}</figcaption>`;
          }
          imgBlock += `</figure>\n<!-- /wp:image -->`;
          wpParts.push(imgBlock);
        }
        break;
      }
      case "table": {
        let tableHtml = `<!-- wp:table -->\n<figure class="wp-block-table"><table><tbody>`;
        for (const row of block.rows) {
          tableHtml += `<tr>`;
          for (const cell of row.cells) {
            const colspan = cell.colspan && cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "";
            const rowspan = cell.rowspan && cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "";
            tableHtml += `<td${colspan}${rowspan}>${escapeHtml(cell.text)}</td>`;
          }
          tableHtml += `</tr>`;
        }
        tableHtml += `</tbody></table></figure>\n<!-- /wp:table -->`;
        wpParts.push(tableHtml);
        break;
      }
      case "divider": {
        wpParts.push(`<!-- wp:separator -->\n<hr class="wp-block-separator"/>\n<!-- /wp:separator -->`);
        break;
      }
    }
  }

  return wpParts.join("\n\n");
}

export function extractDocsRichBlocksFromDom(
  docOrRoot: any,
  options?: { pageCount?: number }
): {
  blocks: DocsContentBlock[];
  verificationScopes: DocsVerificationScopes;
  warnings: string[];
} {
  const blocks: DocsContentBlock[] = [];
  const warnings: string[] = [];
  let blockCounter = 0;
  let lastTextBlockId: string | null = null;

  function nextId(type: string): string {
    return `${type}-${blockCounter++}`;
  }

  function clean(str: unknown): string {
    return String(str || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function parseAttributes(raw: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const re = /([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const name = m[1].toLowerCase();
      const val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ""));
      attrs[name] = val;
    }
    return attrs;
  }

  function detectPlacementFromAttrs(attrs: Record<string, string>): DocsImagePlacement {
    const dataPlacement = (attrs["data-placement"] || "").toLowerCase();
    if (dataPlacement === "unknown") return "unknown";
    if (dataPlacement === "floating") return "floating";
    if (dataPlacement === "anchored") return "anchored";
    if (dataPlacement === "inline") return "inline";

    const style = (attrs["style"] || "").toLowerCase();
    if (style.includes("position: absolute") || style.includes("position: fixed")) return "floating";
    if (style.includes("float: left") || style.includes("float: right")) return "anchored";
    if (attrs["data-anchor"]) return "anchored";
    return "inline";
  }

  function buildImageBlock(
    attrs: Record<string, string>,
    anchorId?: string | null,
    overridePlacement?: DocsImagePlacement
  ): DocsImageBlock {
    const placement = overridePlacement || detectPlacementFromAttrs(attrs);
    const src = attrs["src"] || attrs["data-src"] || undefined;
    const alt = clean(attrs["alt"] || attrs["aria-label"] || "") || undefined;
    const title = clean(attrs["title"] || "") || undefined;
    const caption = clean(attrs["data-caption"] || attrs["caption"] || "") || undefined;

    let anchorType: DocsImageBlock["anchorType"] = "unknown";
    let anchorBlockId: string | undefined = undefined;

    if (placement === "inline") {
      anchorType = "inline_with_text";
      anchorBlockId = attrs["data-anchor-id"] || anchorId || undefined;
    } else if (placement === "anchored") {
      anchorType = "wrap_text";
      anchorBlockId = attrs["data-anchor-id"] || anchorId || undefined;
    } else if (placement === "floating") {
      if (attrs["data-anchor-id"]) {
        anchorBlockId = attrs["data-anchor-id"];
        anchorType = "wrap_text";
      } else {
        anchorType = "unknown";
      }
    }

    const width = Number(attrs["width"]) || undefined;
    const height = Number(attrs["height"]) || undefined;
    const dimensions: DocsImageDimensions | undefined = (width || height) ? {
      width,
      height,
      naturalWidth: width,
      naturalHeight: height,
      aspectRatio: (width && height) ? Number((width / height).toFixed(4)) : undefined,
    } : undefined;

    let binaryReference: DocsImageBinaryReference | undefined = undefined;
    if (src) {
      let bType: DocsImageBinaryReference["type"] = "unknown";
      let recoverable = false;
      if (src.startsWith("data:")) {
        bType = "data_uri";
        recoverable = true;
      } else if (src.startsWith("blob:")) {
        bType = "blob_url";
        recoverable = true;
      } else if (/^https?:\/\//i.test(src)) {
        bType = "url";
        recoverable = true;
      }
      binaryReference = { type: bType, url: src, recoverable };
    }

    const id = attrs["id"] || attrs["data-id"] || nextId("image");
    return {
      id,
      index: blocks.length,
      type: "image",
      src,
      alt,
      title,
      caption,
      placement,
      anchorBlockId,
      anchorType,
      dimensions,
      binaryReference,
    };
  }

  // 1. If HTML string is passed, parse via regex stream
  if (typeof docOrRoot === "string") {
    const rawHtml = docOrRoot;
    // Tokenize top-level block tokens in document order
    const tokenRe = /<(h[1-6]|table|hr|li|p|figure|img)([^>]*)>([\s\S]*?)<\/\1>|<(img|hr)([^>]*?)\/?>/gi;
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    // Scan for tags in sequential order
    const tagMatches: Array<{ full: string; tag: string; attrs: string; inner: string; start: number }> = [];
    const blockRegex = /<(h[1-6]|table|hr|li|p|figure)\b([^>]*)>([\s\S]*?)<\/\1>|<(img|hr)\b([^>]*?)\/?>/gi;
    while ((match = blockRegex.exec(rawHtml))) {
      const tag = (match[1] || match[4] || "").toLowerCase();
      const attrs = match[2] || match[5] || "";
      const inner = match[3] || "";
      tagMatches.push({ full: match[0], tag, attrs, inner, start: match.index });
    }

    for (const item of tagMatches) {
      const { tag, attrs, inner } = item;
      const attrMap = parseAttributes(attrs);

      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag.replace("h", "")) || 1;
        const text = clean(inner.replace(/<[^>]+>/g, ""));
        if (text) {
          const id = attrMap["id"] || nextId("heading");
          blocks.push({ id, index: blocks.length, type: "heading", level, text });
          lastTextBlockId = id;
        }
      } else if (tag === "table") {
        const rows: DocsTableRow[] = [];
        const trMatches = inner.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
        let maxCols = 0;
        for (let r = 0; r < trMatches.length; r++) {
          const trHtml = trMatches[r];
          const cellMatches = trHtml.match(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi) || [];
          maxCols = Math.max(maxCols, cellMatches.length);
          const cells: DocsTableRow["cells"] = [];
          for (let c = 0; c < cellMatches.length; c++) {
            const cellTagMatch = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/i.exec(cellMatches[c]);
            const cAttrs = parseAttributes(cellTagMatch ? cellTagMatch[2] : "");
            const cText = clean((cellTagMatch ? cellTagMatch[3] : "").replace(/<[^>]+>/g, ""));
            cells.push({
              index: c,
              text: cText,
              colspan: Number(cAttrs["colspan"]) || undefined,
              rowspan: Number(cAttrs["rowspan"]) || undefined,
            });
          }
          rows.push({ index: r, cells });
        }
        const id = attrMap["id"] || nextId("table");
        blocks.push({ id, index: blocks.length, type: "table", rows, totalRows: rows.length, totalCols: maxCols });
        lastTextBlockId = id;
      } else if (tag === "hr") {
        const id = attrMap["id"] || nextId("divider");
        blocks.push({ id, index: blocks.length, type: "divider" });
      } else if (tag === "li") {
        const imgMatch = /<img\b([^>]*?)\/?>/i.exec(inner);
        const text = clean(inner.replace(/<[^>]+>/g, ""));
        const id = attrMap["id"] || nextId("list_item");
        blocks.push({ id, index: blocks.length, type: "list_item", text, listType: "bullet" });
        lastTextBlockId = id;
        if (imgMatch) {
          const imgAttrs = parseAttributes(imgMatch[1]);
          blocks.push(buildImageBlock(imgAttrs, id, "inline"));
        }
      } else if (tag === "img") {
        blocks.push(buildImageBlock(attrMap, lastTextBlockId));
      } else if (tag === "figure") {
        const imgMatch = /<img\b([^>]*?)\/?>/i.exec(inner);
        if (imgMatch) {
          const figCapMatch = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(inner);
          const imgAttrs = parseAttributes(imgMatch[1]);
          if (figCapMatch && !imgAttrs["data-caption"]) {
            imgAttrs["data-caption"] = clean(figCapMatch[1].replace(/<[^>]+>/g, ""));
          }
          blocks.push(buildImageBlock(imgAttrs, lastTextBlockId));
        }
      } else if (tag === "p") {
        // Paragraph may contain text and inline images
        const parts = inner.split(/(<img\b[^>]*?\/?>)/gi);
        for (const part of parts) {
          const imgMatch = /<img\b([^>]*?)\/?>/i.exec(part);
          if (imgMatch) {
            const imgAttrs = parseAttributes(imgMatch[1]);
            blocks.push(buildImageBlock(imgAttrs, lastTextBlockId, "inline"));
          } else {
            const text = clean(part.replace(/<[^>]+>/g, ""));
            if (text) {
              const id = nextId("paragraph");
              blocks.push({ id, index: blocks.length, type: "paragraph", text });
              lastTextBlockId = id;
            }
          }
        }
      }
    }
  } else if (docOrRoot && typeof docOrRoot === "object") {
    // 2. DOM Node / Element tree traversal
    const root = docOrRoot.querySelector ? (docOrRoot.querySelector(".doc-content, .kix-embedded-viewer, #contents") || docOrRoot.body || docOrRoot) : docOrRoot;

    function walkNode(node: any): void {
      if (!node || node.nodeType !== 1) return;
      const tag = String(node.tagName || "").toLowerCase();

      if (/^h[1-6]$/.test(tag) || node.getAttribute?.("role") === "heading") {
        const level = Number(tag.replace("h", "")) || Number(node.getAttribute?.("aria-level")) || 1;
        const text = clean(node.innerText || node.textContent || "");
        if (text) {
          const id = node.getAttribute?.("id") || nextId("heading");
          blocks.push({ id, index: blocks.length, type: "heading", level, text });
          lastTextBlockId = id;
        }
        return;
      }

      if (tag === "table") {
        const rows: DocsTableRow[] = [];
        const trs = Array.from(node.querySelectorAll ? node.querySelectorAll("tr") : []);
        let maxCols = 0;
        for (let r = 0; r < trs.length; r++) {
          const tr: any = trs[r];
          const cells: DocsTableRow["cells"] = [];
          const tds = Array.from(tr.querySelectorAll ? tr.querySelectorAll(":scope > th, :scope > td") : []);
          maxCols = Math.max(maxCols, tds.length);
          for (let c = 0; c < tds.length; c++) {
            const cell: any = tds[c];
            const text = clean(cell.innerText || cell.textContent || "");
            const colspan = Number(cell.getAttribute?.("colspan") || 1);
            const rowspan = Number(cell.getAttribute?.("rowspan") || 1);
            cells.push({ index: c, text, colspan, rowspan });
          }
          rows.push({ index: r, cells });
        }
        const id = node.getAttribute?.("id") || nextId("table");
        blocks.push({ id, index: blocks.length, type: "table", rows, totalRows: rows.length, totalCols: maxCols });
        lastTextBlockId = id;
        return;
      }

      if (tag === "hr") {
        const id = node.getAttribute?.("id") || nextId("divider");
        blocks.push({ id, index: blocks.length, type: "divider" });
        return;
      }

      if (tag === "li" || node.getAttribute?.("role") === "listitem") {
        const text = clean(node.innerText || node.textContent || "");
        const id = node.getAttribute?.("id") || nextId("list_item");
        blocks.push({ id, index: blocks.length, type: "list_item", text, listType: "bullet" });
        lastTextBlockId = id;
        const img = node.querySelector ? node.querySelector("img") : null;
        if (img) {
          const attrs: Record<string, string> = {
            id: img.getAttribute?.("id") || "",
            src: img.getAttribute?.("src") || img.src || "",
            alt: img.getAttribute?.("alt") || "",
            title: img.getAttribute?.("title") || "",
          };
          blocks.push(buildImageBlock(attrs, id, "inline"));
        }
        return;
      }

      if (tag === "img") {
        const attrs: Record<string, string> = {
          id: node.getAttribute?.("id") || "",
          src: node.getAttribute?.("src") || node.src || "",
          alt: node.getAttribute?.("alt") || "",
          title: node.getAttribute?.("title") || "",
          style: node.getAttribute?.("style") || "",
          "data-placement": node.getAttribute?.("data-placement") || "",
          "data-anchor-id": node.getAttribute?.("data-anchor-id") || "",
        };
        blocks.push(buildImageBlock(attrs, lastTextBlockId));
        return;
      }

      if (tag === "figure") {
        const img = node.querySelector ? node.querySelector("img") : null;
        if (img) {
          const fc = node.querySelector ? node.querySelector("figcaption") : null;
          const attrs: Record<string, string> = {
            id: img.getAttribute?.("id") || "",
            src: img.getAttribute?.("src") || img.src || "",
            alt: img.getAttribute?.("alt") || "",
            title: img.getAttribute?.("title") || "",
            style: img.getAttribute?.("style") || "",
            "data-placement": img.getAttribute?.("data-placement") || "",
            "data-anchor-id": img.getAttribute?.("data-anchor-id") || "",
            "data-caption": clean(fc?.innerText || fc?.textContent || ""),
          };
          blocks.push(buildImageBlock(attrs, lastTextBlockId));
          return;
        }
      }

      if (tag === "p") {
        const childNodes = Array.from(node.childNodes || []);
        let acc = "";
        for (const child of childNodes as any[]) {
          if (child.nodeType === 3) {
            acc += child.textContent || "";
          } else if (child.nodeType === 1) {
            const cTag = String(child.tagName || "").toLowerCase();
            if (cTag === "img") {
              const flushed = clean(acc);
              if (flushed) {
                const pId = nextId("paragraph");
                blocks.push({ id: pId, index: blocks.length, type: "paragraph", text: flushed });
                lastTextBlockId = pId;
                acc = "";
              }
              const attrs: Record<string, string> = {
                id: child.getAttribute?.("id") || "",
                src: child.getAttribute?.("src") || child.src || "",
                alt: child.getAttribute?.("alt") || "",
                title: child.getAttribute?.("title") || "",
                style: child.getAttribute?.("style") || "",
                "data-placement": child.getAttribute?.("data-placement") || "",
              };
              blocks.push(buildImageBlock(attrs, lastTextBlockId, "inline"));
            } else {
              acc += child.innerText || child.textContent || "";
            }
          }
        }
        const rem = clean(acc);
        if (rem) {
          const pId = node.getAttribute?.("id") || nextId("paragraph");
          blocks.push({ id: pId, index: blocks.length, type: "paragraph", text: rem });
          lastTextBlockId = pId;
        }
        return;
      }

      const hasBlockChildren = node.querySelector ? Boolean(node.querySelector("p, h1, h2, h3, h4, h5, h6, table, ul, ol, hr")) : false;
      if (!hasBlockChildren) {
        const text = clean(node.innerText || node.textContent || "");
        const img = node.querySelector ? node.querySelector("img") : null;
        if (text && !img) {
          const pId = node.getAttribute?.("id") || nextId("paragraph");
          blocks.push({ id: pId, index: blocks.length, type: "paragraph", text });
          lastTextBlockId = pId;
          return;
        }
      }

      const children = Array.from(node.children || []);
      for (const c of children) {
        walkNode(c);
      }
    }

    walkNode(root);
  }

  // Resolve anchors for leading images or images followed by structured blocks
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "image" && !b.anchorBlockId && b.placement !== "unknown") {
      if (i + 1 < blocks.length && blocks[i + 1].id) {
        b.anchorBlockId = blocks[i + 1].id;
        b.anchorType = "wrap_text";
      } else {
        b.anchorBlockId = "doc-start";
        b.anchorType = "inline_with_text";
      }
    }
  }

  // Scopes evaluation
  const imageBlocks = blocks.filter((b): b is DocsImageBlock => b.type === "image");
  const tableBlocks = blocks.filter((b): b is DocsTableBlock => b.type === "table");
  const headingBlocks = blocks.filter((b): b is DocsHeadingBlock => b.type === "heading");
  const listBlocks = blocks.filter((b): b is DocsListItemBlock => b.type === "list_item");

  const hasImages = imageBlocks.length > 0;
  const allImagesAnchored = hasImages && imageBlocks.every(
    img => Boolean(img.anchorBlockId) && img.placement !== "unknown" && img.anchorType !== "unknown"
  );
  const allImagesBinaryOk = hasImages && imageBlocks.every(
    img => Boolean(img.binaryReference && img.binaryReference.recoverable)
  );
  const hasUnknownImageAnchor = hasImages && imageBlocks.some(
    img => !img.anchorBlockId || img.placement === "unknown" || img.anchorType === "unknown"
  );

  const verificationScopes: DocsVerificationScopes = {
    text_content: blocks.some(b => "text" in b) ? "verified" : "not_read",
    block_order: blocks.length > 0 ? (hasUnknownImageAnchor ? "partial" : "verified") : "unavailable",
    image_order: hasImages ? (hasUnknownImageAnchor ? "partial" : "verified") : "none_found",
    image_anchor: hasImages ? (allImagesAnchored ? "verified" : "unknown") : "none_found",
    image_binary: hasImages ? (allImagesBinaryOk ? "verified" : "partial") : "none_found",
    tables: tableBlocks.length > 0 ? "verified" : "none_found",
    headings: headingBlocks.length > 0 ? "verified" : "none_found",
    lists: listBlocks.length > 0 ? "verified" : "none_found",
    captions: imageBlocks.some(img => Boolean(img.caption)) ? "verified" : "none_found",
    comments: "not_read",
    suggestions: "not_read",
    drawings: "not_read",
    footnotes: "not_read",
    document_tabs: "unknown",
    images: hasImages ? (allImagesAnchored ? "verified" : "partial") : "not_read",
  };

  if (hasUnknownImageAnchor) {
    warnings.push("Document contains floating or unanchored images whose exact relative sequence cannot be proven.");
  }

  return {
    blocks,
    verificationScopes,
    warnings,
  };
}

export interface SheetsCapabilities {
  displayed_values: "verified" | "available" | "unavailable";
  formulas_types: "unavailable";
  hidden_rows_cols: "unknown";
  frozen_panes: "unknown";
  filters: "unknown";
  merged_ranges: "available" | "none_found" | "unknown";
  notes_comments: "unavailable";
}

export interface SlidesVerificationScopes {
  slide_text: "verified" | "partial";
  speaker_notes: "not_read" | "unavailable";
  hyperlinks: "verified" | "partial" | "none_found" | "not_read";
  images_alt_text: "partial" | "not_read";
  media_references: "unavailable";
}

export type FormMode = "forms_home" | "editor" | "public_form" | "responses" | "unknown";

export interface FormQuestion {
  index: number;
  id?: string;
  title: string;
  type: string;
  required: boolean;
  options?: string[];
  helpText?: string;
}

export interface FormSection {
  index: number;
  title: string;
  description?: string;
}

export function detectGoogleWorkspaceApp(url: string): GoogleWorkspaceApp {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    const p = u.pathname;
    if (h === "docs.google.com") {
      if (p.includes("/document/")) return "docs";
      if (p.includes("/spreadsheets/")) return "sheets";
      if (p.includes("/presentation/")) return "slides";
      if (p.includes("/forms/")) return "forms";
    }
    if (h === "drive.google.com") return "drive";
    if (h === "accounts.google.com") {
      const cont = u.searchParams.get("continue");
      if (cont) return detectGoogleWorkspaceApp(cont);
    }
  } catch {}
  return "unknown";
}

function idFromPath(url: string, marker: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.indexOf(marker);
    return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
  } catch {
    return null;
  }
}

function accountPrefixFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const uIndex = parts.indexOf("u");
    if (uIndex >= 0 && /^\d+$/.test(parts[uIndex + 1] || "")) {
      return `/u/${parts[uIndex + 1]}`;
    }
    const authuser = u.searchParams.get("authuser");
    if (authuser && /^\d+$/.test(authuser)) {
      return `/u/${authuser}`;
    }
  } catch {}
  return "";
}

export function buildWorkspaceReadRoute(url: string, gidOverride?: string | number | null): WorkspaceReadRoute | null {
  const app = detectGoogleWorkspaceApp(url);
  try {
    const u = new URL(url);
    const accountPrefix = accountPrefixFromUrl(url);
    if (app === "docs") {
      const id = idFromPath(url, "d");
      if (!id) return null;
      return {
        app,
        source: "preview",
        url: `https://docs.google.com/document${accountPrefix}/d/${encodeURIComponent(id)}/preview`,
      };
    }
    if (app === "sheets") {
      const id = idFromPath(url, "d");
      if (!id) return null;
      const override = gidOverride === undefined || gidOverride === null ? "" : String(gidOverride).trim();
      const gid =
        (override && /^\d+$/.test(override) ? override : "") ||
        u.searchParams.get("gid") ||
        ((u.hash.match(/(?:^|[&#])gid=(\d+)/) || [])[1]) ||
        "0";
      return {
        app,
        source: "htmlview",
        url: `https://docs.google.com/spreadsheets${accountPrefix}/d/${encodeURIComponent(id)}/htmlview?gid=${encodeURIComponent(gid)}`,
      };
    }
    if (app === "slides") {
      const id = idFromPath(url, "d");
      if (!id) return null;
      return {
        app,
        source: "htmlpresent",
        url: `https://docs.google.com/presentation${accountPrefix}/d/${encodeURIComponent(id)}/htmlpresent`,
      };
    }
    if (app === "drive" || app === "forms") {
      return { app, source: "current", url };
    }
  } catch {}
  return null;
}

export function detectWorkspaceFailure(pageState: {
  url?: string;
  title?: string;
  bodyText?: string;
  headings?: string[];
}): WorkspaceFailureDetection {
  const url = String(pageState.url || "");
  const title = String(pageState.title || "").toLowerCase();
  const bodyText = String(pageState.bodyText || "");
  const headings = Array.isArray(pageState.headings) ? pageState.headings.join(" ").toLowerCase() : "";
  const combined = (title + " " + headings + " " + bodyText.slice(0, 3000)).toLowerCase();

  // 1. login_required
  if (
    /accounts\.google\.com\/(?:servicelogin|signin|v3\/signin|accountchooser)/i.test(url) ||
    /sign in - google accounts|masuk - akun google|choose an account|pilih akun/i.test(title) ||
    /sign in to continue to google|sign in with your google account|gunakan akun google anda/i.test(combined)
  ) {
    return {
      failed: true,
      reason: "login_required",
      message: "Google Workspace authentication required. Current session is signed out or redirected to Google Sign-In.",
      url,
      title: pageState.title,
    };
  }

  // 2. access_denied / permission_request
  const isPermissionRequest =
    /request access|minta akses|ask for access|request edit access|minta akses edit/i.test(combined) ||
    /you need permission|anda memerlukan izin/i.test(combined);
  const isAccessDenied =
    /access denied|permission denied|akses ditolak|authfailure|error=access_denied/i.test(combined) ||
    /you need access|anda memerlukan akses/i.test(title);

  if (isPermissionRequest || isAccessDenied) {
    const reason: WorkspaceFailureReason = isPermissionRequest ? "permission_request" : "access_denied";
    return {
      failed: true,
      reason,
      message: isPermissionRequest
        ? "Google Workspace document access requires owner permission or approval."
        : "Google Workspace access denied: current user does not have permission to view this document.",
      url,
      title: pageState.title,
    };
  }

  // 3. file_not_found / deleted
  if (
    /file not found|page not found|document look-up failed|halaman tidak ditemukan|berkas tidak ditemukan/i.test(title) ||
    /file not found|page not found|document look-up failed/i.test(headings) ||
    /we're sorry, this document is not found|we're sorry, this file does not exist|it may have been deleted|sorry, the file you have requested does not exist|404\. that’s an error|the requested url was not found on this server/i.test(combined)
  ) {
    return {
      failed: true,
      reason: "file_not_found",
      message: "Google Workspace file not found or deleted (404).",
      url,
      title: pageState.title,
    };
  }

  // 4. google_error
  if (
    /google docs has encountered an error|google sheets has encountered an error|google slides has encountered an error|temporary error \(500\)|server error/i.test(combined) ||
    /something went wrong\. please reload this page|terjadi kesalahan\. silakan muat ulang/i.test(combined)
  ) {
    return {
      failed: true,
      reason: "google_error",
      message: "Google Workspace service error encountered (500 / server error).",
      url,
      title: pageState.title,
    };
  }

  return { failed: false };
}

export const WORKSPACE_FAILURE_DETECTION_JS = String.raw`/*cdp-workspace-failure-detection*/(() => {
  const url = location.href;
  const title = (document.title || "").toLowerCase();
  const bodyText = (document.body ? document.body.innerText : "").slice(0, 3000).toLowerCase();
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
    .map(h => (h.innerText || h.getAttribute("aria-label") || "").toLowerCase())
    .join(" ");
  const combined = title + " " + headings + " " + bodyText;

  if (
    /accounts\.google\.com\/(?:servicelogin|signin|v3\/signin|accountchooser)/i.test(url) ||
    /sign in - google accounts|masuk - akun google|choose an account|pilih akun/i.test(title) ||
    /sign in to continue to google|sign in with your google account|gunakan akun google anda/i.test(combined)
  ) {
    return { failed: true, reason: "login_required", message: "Google Workspace authentication required. Target is signed out or on Google Sign-In.", url, title: document.title };
  }

  const isPermissionRequest =
    /request access|minta akses|ask for access|request edit access|minta akses edit/i.test(combined) ||
    /you need permission|anda memerlukan izin/i.test(combined);
  const isAccessDenied =
    /access denied|permission denied|akses ditolak|authfailure|error=access_denied/i.test(combined) ||
    /you need access|anda memerlukan akses/i.test(title);

  if (isPermissionRequest || isAccessDenied) {
    const reason = isPermissionRequest ? "permission_request" : "access_denied";
    return {
      failed: true,
      reason,
      message: isPermissionRequest
        ? "Google Workspace document access requires owner permission or approval."
        : "Google Workspace access denied: current user does not have permission to view this document.",
      url,
      title: document.title
    };
  }

  if (
    /file not found|page not found|document look-up failed|halaman tidak ditemukan|berkas tidak ditemukan/i.test(title) ||
    /file not found|page not found|document look-up failed/i.test(headings) ||
    /we're sorry, this document is not found|we're sorry, this file does not exist|it may have been deleted|sorry, the file you have requested does not exist|404\. that’s an error|the requested url was not found on this server/i.test(combined)
  ) {
    return { failed: true, reason: "file_not_found", message: "Google Workspace file not found or deleted (404).", url, title: document.title };
  }

  if (
    /google docs has encountered an error|google sheets has encountered an error|google slides has encountered an error|temporary error \(500\)|server error/i.test(combined) ||
    /something went wrong\. please reload this page|terjadi kesalahan\. silakan muat ulang/i.test(combined)
  ) {
    return { failed: true, reason: "google_error", message: "Google Workspace service error encountered (500 / server error).", url, title: document.title };
  }

  return { failed: false };
})()`;

const NORMALIZE_TEXT_FN = String.raw`
  function cleanText(v) {
    return String(v || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
`;

export function buildWorkspaceReadExpression(app: GoogleWorkspaceApp, options?: { allSheets?: boolean }): string {
  const allSheetsOption = options?.allSheets === true;

  if (app === "sheets") {
    return String.raw`/*cdp-workspace-sheets*/(async () => {
      ${NORMALIZE_TEXT_FN}
      const failureCheck = ${WORKSPACE_FAILURE_DETECTION_JS};
      if (failureCheck && failureCheck.failed) {
        return {
          kind: "google_sheets",
          status: "failed",
          complete: false,
          failed: true,
          reason: failureCheck.reason,
          error: failureCheck.message,
          url: location.href,
          title: document.title,
          warnings: [failureCheck.message]
        };
      }

      function extractTable(doc) {
        const table = doc.querySelector("table");
        if (!table) return null;
        const rows = [];
        let totalCells = 0;
        const mergedRanges = [];
        const trs = Array.from(table.querySelectorAll("tr"));
        for (let r = 0; r < trs.length; r++) {
          const cells = [];
          const tds = Array.from(trs[r].querySelectorAll(":scope > th, :scope > td"));
          for (let c = 0; c < tds.length; c++) {
            const cell = tds[c];
            const text = cleanText(cell.innerText || cell.textContent || "");
            const colspan = Number(cell.getAttribute("colspan") || 1);
            const rowspan = Number(cell.getAttribute("rowspan") || 1);
            cells.push({ index: c, text, colspan, rowspan });
            totalCells++;
            if (colspan > 1 || rowspan > 1) {
              mergedRanges.push({ row: r, col: c, colspan, rowspan, text: text.slice(0, 100) });
            }
          }
          rows.push({ index: r, cells });
        }
        return { rows, totalCells, mergedRanges };
      }

      const defaultCapabilities = {
        displayed_values: "verified",
        formulas_types: "unavailable",
        hidden_rows_cols: "unknown",
        frozen_panes: "unknown",
        filters: "unknown",
        merged_ranges: "available",
        notes_comments: "unavailable"
      };

      const frames = Array.from(document.querySelectorAll("iframe"));
      let sourceDoc = document;
      let frameUrl = "";
      for (const frame of frames) {
        try {
          if (frame.contentDocument && frame.contentDocument.body) {
            const table = frame.contentDocument.querySelector("table");
            if (table) {
              sourceDoc = frame.contentDocument;
              frameUrl = frame.contentWindow && frame.contentWindow.location ? String(frame.contentWindow.location.href || "") : String(frame.src || "");
              break;
            }
          }
        } catch {}
      }

      const initialExtracted = extractTable(sourceDoc);
      const rows = initialExtracted ? initialExtracted.rows : [];
      const totalCells = initialExtracted ? initialExtracted.totalCells : 0;
      const mergedRanges = initialExtracted ? initialExtracted.mergedRanges : [];
      const tableFound = Boolean(initialExtracted && initialExtracted.rows.length > 0);

      const activeSheet = cleanText(document.querySelector(".switcherItemActive")?.innerText || "");
      const activeGid = ((frameUrl.match(/[?&]gid=(\d+)/) || [])[1]) || "";
      const switcherNames = Array.from(new Set(
        Array.from(document.querySelectorAll(".switcherItemActive,.switcherItem"))
          .map(el => cleanText(el.innerText || ""))
          .filter(Boolean)
      )).slice(0, 50);

      const shouldReadAllSheets = ${allSheetsOption ? "true" : "false"};

      if (shouldReadAllSheets) {
        const sheets = [];
        if (switcherNames.length <= 1) {
          // Single sheet workbook or switcher not present
          const sheetName = activeSheet || (switcherNames[0] || "Sheet1");
          sheets.push({
            name: sheetName,
            gid: activeGid || "0",
            rows,
            totalRows: rows.length,
            totalCells,
            mergedRanges,
            capabilities: {
              ...defaultCapabilities,
              merged_ranges: mergedRanges.length > 0 ? "available" : "none_found"
            },
            status: tableFound ? "verified" : "partial"
          });
        } else {
          // Multiple sheet tabs: iterate over each tab
          for (const name of switcherNames) {
            const el = Array.from(document.querySelectorAll(".switcherItemActive,.switcherItem"))
              .find(x => cleanText(x.innerText || "") === name);
            if (!el) continue;
            if (!el.classList.contains("switcherItemActive")) {
              try { el.click(); } catch {}
            }
            const deadline = Date.now() + 2000;
            let tabUrl = "";
            let tabDoc = null;
            let tabExtracted = null;
            while (Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 75));
              const frame = document.querySelector("iframe");
              try {
                tabUrl = frame?.contentWindow?.location?.href || frame?.src || "";
                if (frame?.contentDocument) {
                  tabExtracted = extractTable(frame.contentDocument);
                }
              } catch {}
              const currentName = cleanText(document.querySelector(".switcherItemActive")?.innerText || "");
              if (currentName === name && tabExtracted && tabExtracted.rows.length > 0) break;
            }
            const tabGid = ((tabUrl.match(/[?&]gid=(\d+)/) || [])[1]) || "";
            const tabRows = tabExtracted ? tabExtracted.rows : [];
            const tabCells = tabExtracted ? tabExtracted.totalCells : 0;
            const tabMerged = tabExtracted ? tabExtracted.mergedRanges : [];
            const isTabVerified = tabRows.length > 0;
            sheets.push({
              name,
              gid: tabGid,
              rows: tabRows,
              totalRows: tabRows.length,
              totalCells: tabCells,
              mergedRanges: tabMerged,
              capabilities: {
                ...defaultCapabilities,
                displayed_values: isTabVerified ? "verified" : "unavailable",
                merged_ranges: tabMerged.length > 0 ? "available" : "none_found"
              },
              status: isTabVerified ? "verified" : "partial"
            });
          }
          // Restore active sheet if needed
          if (activeSheet) {
            const original = Array.from(document.querySelectorAll(".switcherItemActive,.switcherItem"))
              .find(x => cleanText(x.innerText || "") === activeSheet);
            if (original && !original.classList.contains("switcherItemActive")) {
              try { original.click(); } catch {}
            }
          }
        }

        const totalSheets = sheets.length;
        const sheetsRead = sheets.filter(s => s.status === "verified").length;
        const aggTotalRows = sheets.reduce((sum, s) => sum + s.totalRows, 0);
        const aggTotalCells = sheets.reduce((sum, s) => sum + s.totalCells, 0);
        const isWorkbookComplete = totalSheets > 0 && sheetsRead === totalSheets;

        return {
          kind: "google_sheets",
          source: frameUrl ? "htmlview_iframe" : "htmlview_dom",
          url: location.href,
          frameUrl,
          title: document.title,
          verificationScope: "workbook",
          activeSheet,
          activeGid,
          totalSheets,
          sheetsRead,
          totalRows: aggTotalRows,
          totalCells: aggTotalCells,
          sheets,
          capabilities: {
            ...defaultCapabilities,
            displayed_values: isWorkbookComplete ? "verified" : "available",
            merged_ranges: sheets.some(s => s.mergedRanges.length > 0) ? "available" : "none_found"
          },
          completeCandidate: isWorkbookComplete,
          warnings: isWorkbookComplete
            ? []
            : ["Workbook contains " + totalSheets + " sheets; only " + sheetsRead + " were successfully verified."]
        };
      }

      // Single sheet behavior (default when allSheets is not requested)
      const sheetTabs = [];
      for (const name of switcherNames) {
        const el = Array.from(document.querySelectorAll(".switcherItemActive,.switcherItem"))
          .find(x => cleanText(x.innerText || "") === name);
        if (!el) continue;
        if (!el.classList.contains("switcherItemActive")) {
          try { el.click(); } catch {}
        }
        const deadline = Date.now() + 1500;
        let tabUrl = "";
        let tabRows = 0;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 75));
          const frame = document.querySelector("iframe");
          try {
            tabUrl = frame?.contentWindow?.location?.href || frame?.src || "";
            tabRows = frame?.contentDocument?.querySelectorAll("tr").length || 0;
          } catch {}
          const currentName = cleanText(document.querySelector(".switcherItemActive")?.innerText || "");
          if (currentName === name && /\/htmlview\/sheet\?/.test(tabUrl) && tabRows > 0) break;
        }
        sheetTabs.push({
          name,
          gid: ((tabUrl.match(/[?&]gid=(\d+)/) || [])[1]) || "",
          rows: tabRows,
          url: tabUrl,
        });
      }
      if (activeSheet) {
        const original = Array.from(document.querySelectorAll(".switcherItemActive,.switcherItem"))
          .find(x => cleanText(x.innerText || "") === activeSheet);
        if (original && !original.classList.contains("switcherItemActive")) {
          try { original.click(); } catch {}
        }
      }

      const multiSheetWarning = sheetTabs.length > 1
        ? ["Workbook contains " + sheetTabs.length + " sheets; this result verifies the active sheet only. Use read_workspace with all_sheets:true or a specific gid from sheetTabs to read another sheet."]
        : [];

      return {
        kind: "google_sheets",
        source: frameUrl ? "htmlview_iframe" : "htmlview_dom",
        url: location.href,
        frameUrl,
        title: document.title,
        verificationScope: "active_sheet",
        activeSheet,
        activeGid,
        totalSheets: sheetTabs.length || (activeSheet ? 1 : 0),
        totalRows: rows.length,
        totalCells,
        mergedRanges,
        capabilities: {
          ...defaultCapabilities,
          merged_ranges: mergedRanges.length > 0 ? "available" : "none_found"
        },
        sheetTabs,
        rows,
        completeCandidate: Boolean(frameUrl && tableFound),
        warnings: frameUrl && tableFound
          ? multiSheetWarning
          : ["No structured sheet iframe/table found; parent wrapper tables are not accepted as complete sheet data."],
      };
    })()`;
  }

  if (app === "slides") {
    return String.raw`/*cdp-workspace-slides*/(() => {
      ${NORMALIZE_TEXT_FN}
      const failureCheck = ${WORKSPACE_FAILURE_DETECTION_JS};
      if (failureCheck && failureCheck.failed) {
        return {
          kind: "google_slides",
          status: "failed",
          complete: false,
          failed: true,
          reason: failureCheck.reason,
          error: failureCheck.message,
          url: location.href,
          title: document.title,
          warnings: [failureCheck.message]
        };
      }

      const text = cleanText(document.body ? document.body.innerText : "");
      const lines = text.split("\n");
      const slides = [];
      let current = null;
      let detectedTotal = 0;
      const marker = /^\s*(\d+)\s+(?:of|dari)\s+(\d+)\s*$/i;
      for (const line of lines) {
        const m = line.match(marker);
        if (m) {
          if (current) {
            current.text = cleanText(current.parts.join("\n"));
            delete current.parts;
            slides.push(current);
          }
          detectedTotal = Math.max(detectedTotal, Number(m[2]) || 0);
          current = { index: Number(m[1]) || slides.length + 1, parts: [] };
          continue;
        }
        if (current) current.parts.push(line);
      }
      if (current) {
        current.text = cleanText(current.parts.join("\n"));
        delete current.parts;
        slides.push(current);
      }

      const links = Array.from(document.querySelectorAll("a[href]"))
        .map(a => ({ text: cleanText(a.innerText || a.getAttribute("aria-label") || ""), href: a.href || "" }))
        .filter(x => x.href && !x.href.startsWith("javascript:"));

      const images = Array.from(document.querySelectorAll("img"))
        .map(img => ({
          src: String(img.src || "").slice(0, 500),
          alt: cleanText(img.getAttribute("alt") || img.getAttribute("aria-label") || "")
        }))
        .filter(x => x.src || x.alt);

      const isSlidesComplete = slides.length > 0 && (detectedTotal === 0 || slides.length === detectedTotal);
      const verificationScopes = {
        slide_text: isSlidesComplete ? "verified" : "partial",
        speaker_notes: "not_read",
        hyperlinks: links.length > 0 ? "verified" : "none_found",
        images_alt_text: images.length > 0 ? "partial" : "not_read",
        media_references: "unavailable"
      };

      return {
        kind: "google_slides",
        source: "htmlpresent",
        url: location.href,
        title: document.title,
        totalSlides: detectedTotal || slides.length,
        slidesRead: slides.length,
        slides,
        links,
        images: images.length > 0 ? images : undefined,
        verificationScopes,
        completeCandidate: isSlidesComplete,
        warnings: isSlidesComplete
          ? ["Slide text and links verified via htmlpresent; speaker notes and media references are not exposed in htmlpresent and marked not_read."]
          : (slides.length ? ["Slide deck extraction incomplete; read " + slides.length + " of " + detectedTotal + " slides."] : ["No slide markers found in htmlpresent text."]),
      };
    })()`;
  }

  if (app === "docs") {
    return String.raw`/*cdp-workspace-docs*/(() => {
      ${NORMALIZE_TEXT_FN}
      const failureCheck = ${WORKSPACE_FAILURE_DETECTION_JS};
      if (failureCheck && failureCheck.failed) {
        return {
          kind: "google_docs",
          status: "failed",
          complete: false,
          failed: true,
          reason: failureCheck.reason,
          error: failureCheck.message,
          url: location.href,
          title: document.title,
          warnings: [failureCheck.message]
        };
      }

      const bodyText = cleanText(document.body ? document.body.innerText : "");
      const ariaTexts = Array.from(document.querySelectorAll("[aria-label]"))
        .map(el => cleanText(el.getAttribute("aria-label") || ""))
        .filter(Boolean);
      const pageSignals = [];
      const pageRe = /\b(\d+)\s+(?:of|dari)\s+(\d+)\b/ig;
      for (const s of [bodyText, ...ariaTexts]) {
        let m;
        while ((m = pageRe.exec(s))) {
          pageSignals.push({ current: Number(m[1]), total: Number(m[2]) });
          if (pageSignals.length > 100) break;
        }
      }
      const pageCount = pageSignals.reduce((n, x) => Math.max(n, x.total || 0), 0);
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
        .map(h => cleanText(h.innerText || h.getAttribute("aria-label") || ""))
        .filter(Boolean);

      // Block extraction in document flow order
      const container = document.querySelector(".doc-content, .kix-embedded-viewer, #contents") || document.body;
      const blocks = [];
      let blockSeq = 0;
      let lastTextBlockId = null;

      function getNextId(type) {
        return type + "-" + (blockSeq++);
      }

      function detectImagePlacement(img) {
        const style = (img.getAttribute("style") || "").toLowerCase();
        const pStyle = (img.parentElement ? (img.parentElement.getAttribute("style") || "") : "").toLowerCase();
        const comb = style + " " + pStyle;
        const attr = (img.getAttribute("data-placement") || "").toLowerCase();
        if (attr === "unknown") return "unknown";
        if (attr === "floating" || comb.includes("position: absolute") || comb.includes("position: fixed")) return "floating";
        if (attr === "anchored" || comb.includes("float: left") || comb.includes("float: right")) return "anchored";
        if (attr === "inline") return "inline";
        if (img.getAttribute("data-anchor")) return "anchored";
        if (img.closest("p, span, li, h1, h2, h3, h4, h5, h6")) return "inline";
        return "inline";
      }

      function detectImageCaption(img) {
        const directCap = img.getAttribute("data-caption") || img.getAttribute("caption");
        if (directCap) return cleanText(directCap);
        const fig = img.closest("figure");
        if (fig) {
          const fc = fig.querySelector("figcaption");
          if (fc) return cleanText(fc.innerText || fc.textContent || "");
        }
        const descId = img.getAttribute("aria-describedby");
        if (descId) {
          const descEl = document.getElementById(descId);
          if (descEl) return cleanText(descEl.innerText || descEl.textContent || "");
        }
        return undefined;
      }

      function createImageBlock(img, anchorId, forcePlacement) {
        const placement = forcePlacement || detectImagePlacement(img);
        const src = String(img.currentSrc || img.src || img.getAttribute("src") || "").trim() || undefined;
        const alt = cleanText(img.getAttribute("alt") || img.getAttribute("aria-label") || "") || undefined;
        const title = cleanText(img.getAttribute("title") || "") || undefined;
        const caption = detectImageCaption(img);

        let anchorType = "unknown";
        let anchorBlockId = undefined;
        if (placement === "inline") {
          anchorType = "inline_with_text";
          anchorBlockId = img.getAttribute("data-anchor-id") || anchorId || undefined;
        } else if (placement === "anchored") {
          anchorType = "wrap_text";
          anchorBlockId = img.getAttribute("data-anchor-id") || anchorId || undefined;
        } else if (placement === "floating") {
          const explicitAnchor = img.getAttribute("data-anchor-id");
          if (explicitAnchor) {
            anchorBlockId = explicitAnchor;
            anchorType = "wrap_text";
          } else {
            anchorType = "unknown";
          }
        }

        const width = img.naturalWidth || Number(img.getAttribute("width")) || (img.clientWidth || undefined);
        const height = img.naturalHeight || Number(img.getAttribute("height")) || (img.clientHeight || undefined);
        const dimensions = (width || height) ? {
          width: width || undefined,
          height: height || undefined,
          naturalWidth: img.naturalWidth || undefined,
          naturalHeight: img.naturalHeight || undefined,
          aspectRatio: (width && height) ? Number((width / height).toFixed(4)) : undefined
        } : undefined;

        let binaryRef = undefined;
        if (src) {
          let bType = "unknown";
          let recoverable = false;
          if (src.startsWith("data:")) {
            bType = "data_uri";
            recoverable = true;
          } else if (src.startsWith("blob:")) {
            bType = "blob_url";
            recoverable = true;
          } else if (/^https?:\/\//i.test(src)) {
            bType = "url";
            recoverable = true;
          }
          binaryRef = { type: bType, url: src, recoverable };
        }

        const id = img.getAttribute("id") || img.getAttribute("data-id") || getNextId("image");
        const block = {
          id,
          index: blocks.length,
          type: "image",
          src,
          alt,
          title,
          caption,
          placement,
          anchorBlockId,
          anchorType,
          dimensions,
          binaryReference: binaryRef
        };
        blocks.push(block);
        return block;
      }

      function walkElement(el) {
        if (!el || el.nodeType !== 1) return;
        const tag = el.tagName.toLowerCase();

        if (/^h[1-6]$/.test(tag) || el.getAttribute("role") === "heading") {
          const level = Number(tag.replace("h", "")) || Number(el.getAttribute("aria-level")) || 1;
          const text = cleanText(el.innerText || el.textContent || "");
          if (text) {
            const id = el.getAttribute("id") || getNextId("heading");
            blocks.push({ id, index: blocks.length, type: "heading", level, text });
            lastTextBlockId = id;
          }
          return;
        }

        if (tag === "table") {
          const rows = [];
          const trs = Array.from(el.querySelectorAll("tr"));
          let maxCols = 0;
          for (let r = 0; r < trs.length; r++) {
            const cells = [];
            const tds = Array.from(trs[r].querySelectorAll(":scope > th, :scope > td"));
            maxCols = Math.max(maxCols, tds.length);
            for (let c = 0; c < tds.length; c++) {
              const cell = tds[c];
              const text = cleanText(cell.innerText || cell.textContent || "");
              const colspan = Number(cell.getAttribute("colspan") || 1);
              const rowspan = Number(cell.getAttribute("rowspan") || 1);
              cells.push({ index: c, text, colspan, rowspan });
            }
            rows.push({ index: r, cells });
          }
          const id = el.getAttribute("id") || getNextId("table");
          blocks.push({ id, index: blocks.length, type: "table", rows, totalRows: rows.length, totalCols: maxCols });
          lastTextBlockId = id;
          return;
        }

        if (tag === "hr") {
          const id = el.getAttribute("id") || getNextId("divider");
          blocks.push({ id, index: blocks.length, type: "divider" });
          return;
        }

        if (tag === "li" || el.getAttribute("role") === "listitem") {
          const img = el.querySelector("img");
          const text = cleanText(el.innerText || el.textContent || "");
          const isOrdered = Boolean(el.closest("ol") || /^\d+[\.\)]\s/.test(text));
          const id = el.getAttribute("id") || getNextId("list_item");
          blocks.push({ id, index: blocks.length, type: "list_item", text, listType: isOrdered ? "ordered" : "bullet" });
          lastTextBlockId = id;
          if (img) {
            createImageBlock(img, id, "inline");
          }
          return;
        }

        if (tag === "img") {
          createImageBlock(el, lastTextBlockId);
          return;
        }

        if (tag === "figure") {
          const img = el.querySelector("img");
          if (img) {
            createImageBlock(img, lastTextBlockId);
            return;
          }
        }

        if (tag === "p") {
          const childNodes = Array.from(el.childNodes);
          let acc = "";
          for (const c of childNodes) {
            if (c.nodeType === 3) {
              acc += c.textContent || "";
            } else if (c.nodeType === 1) {
              const cTag = c.tagName.toLowerCase();
              if (cTag === "img") {
                const flushed = cleanText(acc);
                if (flushed) {
                  const pId = getNextId("paragraph");
                  blocks.push({ id: pId, index: blocks.length, type: "paragraph", text: flushed });
                  lastTextBlockId = pId;
                  acc = "";
                }
                createImageBlock(c, lastTextBlockId, "inline");
              } else if (c.querySelector && c.querySelector("img")) {
                const img = c.querySelector("img");
                const flushed = cleanText(acc);
                if (flushed) {
                  const pId = getNextId("paragraph");
                  blocks.push({ id: pId, index: blocks.length, type: "paragraph", text: flushed });
                  lastTextBlockId = pId;
                  acc = "";
                }
                createImageBlock(img, lastTextBlockId, "inline");
              } else {
                acc += c.innerText || c.textContent || "";
              }
            }
          }
          const rem = cleanText(acc);
          if (rem) {
            const pId = el.getAttribute("id") || getNextId("paragraph");
            blocks.push({ id: pId, index: blocks.length, type: "paragraph", text: rem });
            lastTextBlockId = pId;
          }
          return;
        }

        const hasBlockChildren = Boolean(el.querySelector("p, h1, h2, h3, h4, h5, h6, table, ul, ol, hr"));
        if (!hasBlockChildren) {
          const text = cleanText(el.innerText || el.textContent || "");
          const img = el.querySelector("img");
          if (text && !img) {
            const pId = el.getAttribute("id") || getNextId("paragraph");
            blocks.push({ id: pId, index: blocks.length, type: "paragraph", text });
            lastTextBlockId = pId;
            return;
          }
        }

        for (const child of Array.from(el.children)) {
          walkElement(child);
        }
      }

      walkElement(container);

      // Resolve anchors for leading images or images followed by structured blocks
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type === "image" && !b.anchorBlockId && b.placement !== "unknown") {
          if (i + 1 < blocks.length && blocks[i + 1].id) {
            b.anchorBlockId = blocks[i + 1].id;
            b.anchorType = "wrap_text";
          } else {
            b.anchorBlockId = "doc-start";
            b.anchorType = "inline_with_text";
          }
        }
      }

      const imageBlocks = blocks.filter(b => b.type === "image");
      const tableBlocks = blocks.filter(b => b.type === "table");
      const headingBlocks = blocks.filter(b => b.type === "heading");
      const listBlocks = blocks.filter(b => b.type === "list_item");

      const hasImages = imageBlocks.length > 0;
      const allImagesAnchored = hasImages && imageBlocks.every(img =>
        Boolean(img.anchorBlockId) && img.placement !== "unknown" && img.anchorType !== "unknown"
      );
      const allImagesBinaryOk = hasImages && imageBlocks.every(img =>
        Boolean(img.binaryReference && img.binaryReference.recoverable)
      );
      const hasUnknownImageAnchor = hasImages && imageBlocks.some(img =>
        !img.anchorBlockId || img.placement === "unknown" || img.anchorType === "unknown"
      );

      const isDocsComplete = pageCount === 1 && (bodyText.length > 0 || blocks.length > 0);
      const verificationScopes = {
        text_content: isDocsComplete ? "verified" : (bodyText.length > 0 ? "partial" : "not_read"),
        block_order: blocks.length > 0 ? (hasUnknownImageAnchor ? "partial" : "verified") : "unavailable",
        image_order: hasImages ? (hasUnknownImageAnchor ? "partial" : "verified") : "none_found",
        image_anchor: hasImages ? (allImagesAnchored ? "verified" : "unknown") : "none_found",
        image_binary: hasImages ? (allImagesBinaryOk ? "verified" : "partial") : "none_found",
        tables: tableBlocks.length > 0 ? "verified" : (headings.some(h => /table/i.test(h)) ? "partial" : "not_read"),
        headings: headingBlocks.length > 0 ? "verified" : "not_read",
        lists: listBlocks.length > 0 ? "verified" : "not_read",
        captions: imageBlocks.some(img => Boolean(img.caption)) ? "verified" : "none_found",
        comments: "not_read",
        suggestions: "not_read",
        drawings: "not_read",
        footnotes: "not_read",
        document_tabs: "unknown",
        images: hasImages ? (allImagesAnchored ? "verified" : "partial") : "not_read",
      };

      return {
        kind: "google_docs",
        source: "preview_dom",
        url: location.href,
        title: document.title,
        bodyText,
        headings,
        pageCount,
        pageSignals,
        blocks,
        totalBlocks: blocks.length,
        verificationScope: "text_content",
        verificationScopes,
        completeCandidate: isDocsComplete,
        warnings:
          hasUnknownImageAnchor
            ? ["Document contains floating or unanchored images whose exact relative sequence cannot be proven."]
            : (pageCount > 1
              ? ["Multi-page Docs requires accessibility/page traversal verification."]
              : (pageCount === 0 && bodyText.length > 0
                ? ["Docs preview exposed text, but page completeness could not be proven."]
                : [])),
      };
    })()`;
  }

  if (app === "drive") {
    return String.raw`/*cdp-workspace-drive*/(async () => {
      ${NORMALIZE_TEXT_FN}
      const failureCheck = ${WORKSPACE_FAILURE_DETECTION_JS};
      if (failureCheck && failureCheck.failed) {
        return {
          kind: "google_drive",
          status: "failed",
          complete: false,
          failed: true,
          reason: failureCheck.reason,
          error: failureCheck.message,
          url: location.href,
          title: document.title,
          warnings: [failureCheck.message]
        };
      }

      function findScroller() {
        const all = Array.from(document.querySelectorAll("*"));
        return all
          .map(el => ({ el, gap: (el.scrollHeight || 0) - (el.clientHeight || 0) }))
          .filter(x => x.gap > 200 && x.el.clientHeight > 150)
          .sort((a,b) => b.gap - a.gap)[0]?.el || null;
      }

      function collect(map) {
        const nodes = Array.from(document.querySelectorAll(
          '[role="row"][data-id], [role="gridcell"][data-id], [data-id][data-target="doc"], [data-target-id], [data-selectable][data-id]'
        ));
        for (const el of nodes) {
          const text = cleanText(el.innerText || el.getAttribute("aria-label") || "");
          const id = el.getAttribute("data-id") || el.getAttribute("data-target-id") || el.getAttribute("id") || "";
          if (!id || !text || text.length > 10000 || text.includes("window.WIZ_global_data")) continue;
          const link = el.querySelector && el.querySelector("a[href]");
          const firstLine = text.split("\n").map(x => x.trim()).find(Boolean) || text;
          map.set(String(id), {
            id: String(id).slice(0, 512),
            name: firstLine.slice(0, 1000),
            text: text.slice(0, 4000),
            href: link && link.href ? String(link.href) : undefined,
          });
        }
      }

      const items = new Map();
      const scroller = findScroller();
      const originalTop = scroller ? scroller.scrollTop : 0;
      let stableRounds = 0;
      let iterations = 0;
      let previousSize = -1;
      let reachedEnd = !scroller;

      while (iterations < 60) {
        collect(items);
        if (!scroller) break;
        if (items.size === previousSize) stableRounds++; else stableRounds = 0;
        previousSize = items.size;
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (scroller.scrollTop >= maxTop - 2 && stableRounds >= 2) { reachedEnd = true; break; }
        if (stableRounds >= 5) break;
        scroller.scrollTop = Math.min(maxTop, scroller.scrollTop + Math.max(250, Math.floor(scroller.clientHeight * 0.8)));
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        iterations++;
      }

      collect(items);
      if (scroller) {
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (scroller.scrollTop >= maxTop - 2) reachedEnd = true;
        scroller.scrollTop = originalTop;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      }

      return {
        kind: "google_drive",
        source: "virtual_dom",
        url: location.href,
        title: document.title,
        uniqueItems: items.size,
        iterations,
        reachedEnd,
        items: Array.from(items.values()),
        completeCandidate: reachedEnd,
        warnings: reachedEnd ? [] : ["Drive virtual-list traversal stopped before deterministic end-of-list evidence."],
      };
    })()`;
  }

  if (app === "forms") {
    return String.raw`/*cdp-workspace-forms*/(() => {
      ${NORMALIZE_TEXT_FN}
      const failureCheck = ${WORKSPACE_FAILURE_DETECTION_JS};
      if (failureCheck && failureCheck.failed) {
        return {
          kind: "google_forms",
          status: "failed",
          complete: false,
          failed: true,
          reason: failureCheck.reason,
          error: failureCheck.message,
          url: location.href,
          title: document.title,
          warnings: [failureCheck.message]
        };
      }

      const url = location.href;
      let formMode = "unknown";
      if (/\/forms\/u\/\d+\/?$/i.test(url) || /\/forms\/?$/i.test(url)) {
        formMode = "forms_home";
      } else if (/#responses\b/i.test(url) || /\/edit#responses\b/i.test(url) || /\/analytics\b/i.test(url)) {
        formMode = "responses";
      } else if (/\/forms\/d\/e\/[^\/]+\/viewform/i.test(url) || /\/viewform\b/i.test(url) || /\/formResponse\b/i.test(url)) {
        formMode = "public_form";
      } else if (/\/forms\/d\/[^\/]+\/edit\b/i.test(url)) {
        const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
        const activeTabText = (activeTab ? activeTab.innerText || "" : "").toLowerCase();
        if (/responses|tanggapan/i.test(activeTabText)) {
          formMode = "responses";
        } else {
          formMode = "editor";
        }
      }

      const bodyText = cleanText(document.body ? document.body.innerText : "");

      if (formMode === "responses") {
        return {
          kind: "google_forms",
          formMode: "responses",
          source: "dom",
          url: location.href,
          title: document.title,
          bodyText,
          questions: [],
          sections: [],
          completeCandidate: false,
          warnings: [
            "Form responses tab/view detected. Normal form reading extracts form structure and questions only; submitted user responses are not read as form questions."
          ]
        };
      }

      if (formMode === "forms_home") {
        return {
          kind: "google_forms",
          formMode: "forms_home",
          source: "dom",
          url: location.href,
          title: document.title,
          bodyText,
          questions: [],
          sections: [],
          completeCandidate: false,
          warnings: [
            "Google Forms dashboard / home view detected, not an individual form document."
          ]
        };
      }

      const titleEl = document.querySelector('.freebirdFormviewerViewHeaderTitle, input[aria-label="Form title"], div[role="heading"][aria-level="1"], .F9yp7e');
      const formTitle = cleanText(titleEl ? (titleEl.value || titleEl.innerText || titleEl.textContent || "") : document.title);

      const descEl = document.querySelector('.freebirdFormviewerViewHeaderDescription, div[aria-label="Form description"], textarea[aria-label="Form description"], .M7eMe');
      const formDescription = cleanText(descEl ? (descEl.value || descEl.innerText || descEl.textContent || "") : "");

      const sectionNodes = Array.from(document.querySelectorAll('[role="region"], .freebirdFormeditorViewSectionHeader, [data-section-index], .m2'));
      const sections = sectionNodes.map((sEl, sIdx) => {
        const sTitle = cleanText(sEl.querySelector('h1,h2,h3,[role="heading"],.freebirdFormeditorViewSectionHeaderTitle')?.innerText || sEl.getAttribute("aria-label") || "");
        const sDesc = cleanText(sEl.querySelector('.freebirdFormeditorViewSectionHeaderDescription')?.innerText || "");
        return { index: sIdx + 1, title: sTitle, description: sDesc || undefined };
      }).filter(s => s.title);

      const questionNodes = Array.from(document.querySelectorAll(
        '[role="listitem"], [data-params], [class*="freebirdFormviewerViewItemsItemItem"], [class*="freebirdFormeditorViewItemItem"], [jsmodel][data-item-id]'
      ));
      const questions = [];
      const seenQuestions = new Set();
      for (let i = 0; i < questionNodes.length; i++) {
        const qEl = questionNodes[i];
        const titleNode = qEl.querySelector(
          '[role="heading"], .freebirdFormviewerComponentsQuestionBaseTitle, textarea[aria-label="Question title"], input[aria-label="Question title"], .M7eMe, .HoXoMd'
        );
        let qTitle = cleanText(titleNode ? (titleNode.value || titleNode.innerText || titleNode.textContent || "") : "");
        if (!qTitle) {
          const rawAria = qEl.getAttribute("aria-label");
          if (rawAria) qTitle = cleanText(rawAria);
        }
        const hasAsterisk = /\*/.test(qTitle);
        const required = hasAsterisk || qEl.getAttribute("aria-required") === "true" || !!qEl.querySelector('[aria-required="true"], .freebirdFormviewerComponentsQuestionBaseRequiredAsterisk, [aria-label*="Required" i]');
        qTitle = qTitle.replace(/\s*\*+\s*$/, "").trim();
        if (!qTitle || seenQuestions.has(qTitle)) continue;
        seenQuestions.add(qTitle);

        const helpNode = qEl.querySelector('.freebirdFormviewerComponentsQuestionBaseDescription, div[id*="desc"], .RfhEId');
        const helpText = cleanText(helpNode ? helpNode.innerText || helpNode.textContent || "" : "");

        const radioNodes = Array.from(qEl.querySelectorAll('[role="radio"], input[type="radio"]'));
        const checkboxNodes = Array.from(qEl.querySelectorAll('[role="checkbox"], input[type="checkbox"]'));
        const selectNode = qEl.querySelector('[role="combobox"], [role="listbox"], select');
        const textareaNode = qEl.querySelector('textarea, div[contenteditable="true"]');
        const dateNode = qEl.querySelector('input[type="date"], [aria-label*="date" i]');
        const timeNode = qEl.querySelector('input[type="time"], [aria-label*="time" i]');
        const fileNode = qEl.querySelector('input[type="file"], [data-dropzone], [aria-label*="file" i], [aria-label*="upload" i]');
        const gridNode = qEl.querySelector('table, [role="grid"], [data-grid-row], .freebirdFormviewerViewItemsGridRow, [class*="Grid" i]');

        let qType = "short_answer";
        let options = [];

        if (gridNode && radioNodes.length > 0) {
          qType = "multiple_choice_grid";
          options = radioNodes.map(r => cleanText(r.getAttribute("aria-label") || r.getAttribute("data-value") || r.innerText || "")).filter(Boolean);
        } else if (gridNode && checkboxNodes.length > 0) {
          qType = "checkbox_grid";
          options = checkboxNodes.map(c => cleanText(c.getAttribute("aria-label") || c.getAttribute("data-value") || c.innerText || "")).filter(Boolean);
        } else if (fileNode) {
          qType = "file_upload";
        } else if (radioNodes.length > 0) {
          const isScale = radioNodes.every(r => /^\d+$/.test(cleanText(r.getAttribute("data-value") || r.getAttribute("aria-label") || r.innerText || "")));
          qType = isScale ? "linear_scale" : "multiple_choice";
          options = radioNodes.map(r => cleanText(r.getAttribute("aria-label") || r.getAttribute("data-value") || r.innerText || r.parentElement?.innerText || "")).filter(Boolean);
        } else if (checkboxNodes.length > 0) {
          qType = "checkboxes";
          options = checkboxNodes.map(c => cleanText(c.getAttribute("aria-label") || c.getAttribute("data-value") || c.innerText || c.parentElement?.innerText || "")).filter(Boolean);
        } else if (selectNode) {
          qType = "dropdown";
          options = Array.from(qEl.querySelectorAll('[role="option"], option')).map(o => cleanText(o.innerText || o.getAttribute("data-value") || "")).filter(Boolean);
        } else if (dateNode) {
          qType = "date";
        } else if (timeNode) {
          qType = "time";
        } else if (textareaNode) {
          qType = "paragraph";
        } else {
          const optionInputs = Array.from(qEl.querySelectorAll('input[aria-label*="option" i], input[value*="Option" i]'));
          if (optionInputs.length > 0) {
            qType = "multiple_choice";
            options = optionInputs.map(inp => cleanText(inp.value || inp.getAttribute("aria-label") || "")).filter(Boolean);
          }
        }

        questions.push({
          index: questions.length + 1,
          title: qTitle,
          type: qType,
          required,
          options: options.length > 0 ? options : undefined,
          helpText: helpText || undefined,
        });
      }

      return {
        kind: "google_forms",
        formMode: formMode === "unknown" ? "public_form" : formMode,
        source: "dom",
        url: location.href,
        title: formTitle,
        description: formDescription || undefined,
        sections: sections.length > 0 ? sections : undefined,
        totalQuestions: questions.length,
        questions,
        verificationScopes: {
          form_structure: questions.length > 0 ? "verified" : "partial",
          questions: questions.length > 0 ? "verified" : "partial",
          response_data: "segregated"
        },
        completeCandidate: questions.length > 0,
        warnings: questions.length === 0 ? ["No structured form questions detected in the page DOM."] : []
      };
    })()`;
  }

  return String.raw`/*cdp-workspace-generic*/(() => ({
    kind: "unknown",
    source: "dom",
    url: location.href,
    title: document.title,
    bodyText: document.body ? String(document.body.innerText || "") : "",
    completeCandidate: false,
    warnings: ["Not a recognized Google Workspace URL."]
  }))()`;
}

export const INSPECT_FRAMES_JS = String.raw`/*cdp-inspect-frames*/(() => {
  return Array.from(document.querySelectorAll("iframe")).map((frame, index) => {
    const out = {
      index,
      src: String(frame.src || ""),
      title: String(frame.title || ""),
      name: String(frame.name || ""),
      sameOrigin: false,
      bodyTextLength: 0,
      tables: 0,
      rows: 0,
      cells: 0,
    };
    try {
      const doc = frame.contentDocument;
      if (doc) {
        out.sameOrigin = true;
        out.bodyTextLength = String(doc.body && doc.body.innerText || "").length;
        out.tables = doc.querySelectorAll("table").length;
        out.rows = doc.querySelectorAll("tr").length;
        out.cells = doc.querySelectorAll("td,th").length;
      }
    } catch {}
    return out;
  });
})()`;

export function paginateWorkspaceValue(value: any, cursorRaw: unknown, maxItemsRaw: unknown, maxCharsRaw: unknown): any {
  const cursor = Number.isFinite(Number(cursorRaw)) ? Math.max(0, Math.floor(Number(cursorRaw))) : 0;
  const maxItems = Number.isFinite(Number(maxItemsRaw)) ? Math.max(1, Math.min(500, Math.floor(Number(maxItemsRaw)))) : 100;
  const maxChars = Number.isFinite(Number(maxCharsRaw)) ? Math.max(500, Math.min(100000, Math.floor(Number(maxCharsRaw)))) : 20000;

  if (!value || typeof value !== "object") return value;

  const out: any = { ...value };

  // Fail closed on error pages or failure states: never mark verified!
  if (value.failed === true || value.status === "failed") {
    out.status = "failed";
    out.complete = false;
    out.truncated = false;
    out.hasMore = false;
    delete out.completeCandidate;
    return out;
  }

  // Double check if payload text/title indicates Google Workspace failure
  const detected = detectWorkspaceFailure({
    url: value.url || value.readUrl || value.originalUrl,
    title: value.title,
    bodyText: typeof value.bodyText === "string" ? value.bodyText : undefined,
  });
  if (detected.failed) {
    out.failed = true;
    out.status = "failed";
    out.complete = false;
    out.reason = detected.reason;
    out.error = detected.message;
    out.truncated = false;
    out.hasMore = false;
    out.warnings = [...(out.warnings || []), detected.message];
    delete out.completeCandidate;
    return out;
  }

  let total = 0;
  let nextCursor: number | null = null;

  if (Array.isArray(value.blocks)) {
    total = value.blocks.length;
    out.blocks = value.blocks.slice(cursor, cursor + maxItems);
    nextCursor = cursor + out.blocks.length < total ? cursor + out.blocks.length : null;
    out.totalBlocks = total;
  } else if (Array.isArray(value.sheets)) {
    total = value.sheets.length;
    const slicedSheets = value.sheets.slice(cursor, cursor + maxItems);
    const maxRowsPerSheet = maxChars > 10000 ? 500 : 100;
    out.sheets = slicedSheets.map((s: any) => {
      if (Array.isArray(s.rows) && s.rows.length > maxRowsPerSheet) {
        return {
          ...s,
          rows: s.rows.slice(0, maxRowsPerSheet),
          truncated: true,
          totalRows: s.rows.length,
        };
      }
      return s;
    });
    nextCursor = cursor + slicedSheets.length < total ? cursor + slicedSheets.length : null;
    const anySheetIncomplete = out.sheets.some((s: any) => s.status !== "verified" || s.truncated === true);
    if (anySheetIncomplete) {
      out.completeCandidate = false;
    }
  } else if (Array.isArray(value.rows)) {
    total = value.rows.length;
    out.rows = value.rows.slice(cursor, cursor + maxItems);
    nextCursor = cursor + out.rows.length < total ? cursor + out.rows.length : null;
  } else if (Array.isArray(value.slides)) {
    total = value.slides.length;
    out.slides = value.slides.slice(cursor, cursor + maxItems);
    nextCursor = cursor + out.slides.length < total ? cursor + out.slides.length : null;
  } else if (Array.isArray(value.items)) {
    total = value.items.length;
    out.items = value.items.slice(cursor, cursor + maxItems);
    nextCursor = cursor + out.items.length < total ? cursor + out.items.length : null;
  } else if (Array.isArray(value.questions)) {
    total = value.questions.length;
    out.questions = value.questions.slice(cursor, cursor + maxItems);
    nextCursor = cursor + out.questions.length < total ? cursor + out.questions.length : null;
  } else if (typeof value.bodyText === "string") {
    total = value.bodyText.length;
    out.bodyText = value.bodyText.slice(cursor, cursor + maxChars);
    nextCursor = cursor + out.bodyText.length < total ? cursor + out.bodyText.length : null;
  }

  out.cursor = cursor;
  out.nextCursor = nextCursor;
  out.hasMore = nextCursor !== null;
  out.truncated = nextCursor !== null;
  out.totalAvailable = total || undefined;

  const candidate = value.completeCandidate === true;
  out.complete = candidate && nextCursor === null;
  out.status = out.complete ? "verified" : "partial";
  delete out.completeCandidate;
  return out;
}
