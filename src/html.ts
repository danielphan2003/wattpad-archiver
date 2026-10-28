import render from "dom-serializer";
import { type AnyNode, Element, isTag, isText, Text } from "domhandler";
import { parseDocument } from "htmlparser2";

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "hr",
  "div",
  "span",
  "em",
  "i",
  "strong",
  "b",
  "u",
  "s",
  "strike",
  "del",
  "sub",
  "sup",
  "blockquote",
  "pre",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
]);

/** Elements whose content is never prose, so they go with their children. */
const DISCARDED_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
]);

export const isWattpadImageUrl = (url: string) => {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      (protocol === "https:" || protocol === "http:") &&
      (hostname === "wattpad.com" || hostname.endsWith(".wattpad.com"))
    );
  } catch {
    return false;
  }
};

const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

/**
 * Keeps a small allowlist of tags and attributes so the result is well-formed XHTML.
 * `resolveImage` returns the path an image is stored at, or undefined to drop it.
 */
const sanitize = (
  nodes: ReadonlyArray<AnyNode>,
  resolveImage: (src: string) => string | undefined,
): Array<AnyNode> =>
  nodes.flatMap((node): Array<AnyNode> => {
    if (isText(node)) return [new Text(node.data)];
    if (!isTag(node)) return [];

    const name = node.name.toLowerCase();
    if (DISCARDED_TAGS.has(name)) return [];

    const children = sanitize(node.children, resolveImage);
    if (!ALLOWED_TAGS.has(name)) return children;

    if (name === "img") {
      const path = resolveImage(node.attribs.src ?? "");
      if (path === undefined) return [];
      return [new Element("img", { src: path, alt: node.attribs.alt ?? "" })];
    }
    if (name === "a") {
      const href = node.attribs.href;
      return href !== undefined && isWebUrl(href)
        ? [new Element("a", { href }, children)]
        : children;
    }
    return [new Element(name, {}, children)];
  });

const parseBody = (html: string) => parseDocument(html, { decodeEntities: true }).children;

/** Wattpad-hosted image sources in document order, without duplicates. */
export const extractImageUrls = (html: string): ReadonlyArray<string> => {
  const urls = new Set<string>();
  sanitize(parseBody(html), (src) => {
    if (isWattpadImageUrl(src)) urls.add(src);
    return src;
  });
  return [...urls];
};

/** Well-formed XHTML for one chapter body; `images` maps a source URL to its path in the EPUB. */
export const toXhtml = (html: string, images: ReadonlyMap<string, string>): string =>
  render(
    sanitize(parseBody(html), (src) => images.get(src)),
    {
      xmlMode: true,
      encodeEntities: "utf8",
    },
  );

export const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
