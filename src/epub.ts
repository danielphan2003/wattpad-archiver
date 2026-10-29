import { strToU8, zipSync, type Zippable } from "fflate";

import { escapeXml } from "./html.ts";
import type { Part, Story } from "./wattpad/schema.ts";

/** Wattpad language ids seen in the wild; anything else is `und` rather than a wrong guess. */
const LANGUAGE_CODES: Readonly<Record<number, string>> = { 1: "en", 3: "it", 19: "vi" };

export const languageCode = (id: number) => LANGUAGE_CODES[id] ?? "und";

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const imageExtension = (mediaType: string) => EXTENSIONS[mediaType];

export interface EpubImage {
  /** Path inside the EPUB's content directory, such as `images/img-1.jpg`. */
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface EpubChapter {
  readonly part: Pick<Part, "id" | "title" | "dedication">;
  /** Well-formed XHTML, or undefined when the chapter could not be downloaded. */
  readonly body: string | undefined;
  readonly photoPath?: string | undefined;
}

export interface EpubInput {
  readonly story: Omit<Story, "parts">;
  readonly chapters: ReadonlyArray<EpubChapter>;
  readonly cover: EpubImage | undefined;
  readonly images: ReadonlyArray<EpubImage>;
}

const XHTML_NS = 'xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"';
const STYLESHEET = `body{line-height:1.5;margin:0 5%}p{margin:0 0 .8em;text-indent:0}img{max-width:100%;height:auto}
h1{font-size:1.5em;margin:1em 0}.dedication{font-style:italic}.unavailable{color:#777;font-style:italic}.meta{color:#555}`;

const page = (title: string, language: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html ${XHTML_NS} xml:lang="${language}" lang="${language}"><head><meta charset="utf-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;

const chapterPage = (chapter: EpubChapter, language: string) => {
  const dedication =
    chapter.part.dedication?.name === undefined
      ? ""
      : `<p class="dedication">Dedicated to ${escapeXml(chapter.part.dedication.name)}</p>`;
  const photo =
    chapter.photoPath === undefined
      ? ""
      : `<p><img src="${escapeXml(chapter.photoPath)}" alt=""/></p>`;
  const body =
    chapter.body ?? '<p class="unavailable">This chapter could not be downloaded from Wattpad.</p>';
  return page(
    chapter.part.title,
    language,
    `<h1>${escapeXml(chapter.part.title)}</h1>${dedication}${photo}${body}`,
  );
};

const titlePage = (story: EpubInput["story"], language: string) => {
  const paragraphs = story.description
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => `<p>${escapeXml(line)}</p>`)
    .join("");
  const tags =
    story.tags.length === 0 ? "" : `<p class="meta">${story.tags.map(escapeXml).join(", ")}</p>`;
  return page(
    story.title,
    language,
    `<h1>${escapeXml(story.title)}</h1><p class="meta">by ${escapeXml(story.user.name)}</p>${paragraphs}${tags}<p class="meta"><a href="${escapeXml(story.url)}">${escapeXml(story.url)}</a></p>`,
  );
};

const navPage = (
  story: EpubInput["story"],
  chapters: ReadonlyArray<EpubChapter>,
  language: string,
) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html ${XHTML_NS} xml:lang="${language}" lang="${language}"><head><meta charset="utf-8"/><title>${escapeXml(story.title)}</title></head><body><nav epub:type="toc" id="toc"><ol><li><a href="title.xhtml">${escapeXml(story.title)}</a></li>${chapters
    .map(
      (chapter) =>
        `<li><a href="chapter-${chapter.part.id}.xhtml">${escapeXml(chapter.part.title)}</a></li>`,
    )
    .join("")}</ol></nav></body></html>`;

const MODIFIED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const packageDocument = (input: EpubInput, language: string) => {
  const { story, chapters, cover, images } = input;
  const modified = MODIFIED.test(story.modifyDate) ? story.modifyDate : "1970-01-01T00:00:00Z";
  const manifestImages = [...(cover === undefined ? [] : [cover]), ...images];
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="style" href="style.css" media-type="text/css"/>',
    '<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>',
    ...chapters.map(
      (chapter) =>
        `<item id="c${chapter.part.id}" href="chapter-${chapter.part.id}.xhtml" media-type="application/xhtml+xml"/>`,
    ),
    ...manifestImages.map(
      (image, index) =>
        `<item id="${image === cover ? "cover-image" : `i${index}`}" href="${escapeXml(image.path)}" media-type="${escapeXml(image.mediaType)}"${image === cover ? ' properties="cover-image"' : ""}/>`,
    ),
  ];
  const spine = [
    '<itemref idref="title"/>',
    ...chapters.map((c) => `<itemref idref="c${c.part.id}"/>`),
  ];
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${language}" prefix="wattpad: https://www.wattpad.com/"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">wp${escapeXml(story.id)}</dc:identifier><dc:title>${escapeXml(story.title)}</dc:title><dc:creator>${escapeXml(story.user.name)}</dc:creator><dc:language>${language}</dc:language><dc:publisher>Wattpad</dc:publisher><dc:description>${escapeXml(story.description)}</dc:description><dc:date>${escapeXml(story.createDate.slice(0, 10))}</dc:date><dc:source>${escapeXml(story.url)}</dc:source>${story.tags.map((tag) => `<dc:subject>${escapeXml(tag)}</dc:subject>`).join("")}<meta property="dcterms:modified">${modified}</meta><meta property="wattpad:username">${escapeXml(story.user.username)}</meta><meta property="wattpad:completed">${story.completed}</meta>${cover === undefined ? "" : '<meta name="cover" content="cover-image"/>'}</metadata><manifest>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`;
};

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

// A fixed timestamp keeps the archive byte-identical for identical input.
const FIXED_MTIME = 315_532_800_000;

/** Builds an EPUB 3 archive. The `mimetype` entry comes first and is stored uncompressed, as the spec requires. */
export const buildEpub = (input: EpubInput): Uint8Array => {
  const language = languageCode(input.story.language.id);
  const text = (content: string) => strToU8(content);

  const files: Zippable = {
    mimetype: [text("application/epub+zip"), { level: 0, mtime: FIXED_MTIME }],
    "META-INF/container.xml": [text(CONTAINER), { mtime: FIXED_MTIME }],
    "OEBPS/content.opf": [text(packageDocument(input, language)), { mtime: FIXED_MTIME }],
    "OEBPS/nav.xhtml": [
      text(navPage(input.story, input.chapters, language)),
      { mtime: FIXED_MTIME },
    ],
    "OEBPS/style.css": [text(STYLESHEET), { mtime: FIXED_MTIME }],
    "OEBPS/title.xhtml": [text(titlePage(input.story, language)), { mtime: FIXED_MTIME }],
  };
  for (const chapter of input.chapters) {
    files[`OEBPS/chapter-${chapter.part.id}.xhtml`] = [
      text(chapterPage(chapter, language)),
      { mtime: FIXED_MTIME },
    ];
  }
  // Images are already compressed, so storing them costs less CPU than deflating them.
  for (const image of [...(input.cover === undefined ? [] : [input.cover]), ...input.images]) {
    files[`OEBPS/${image.path}`] = [image.bytes, { level: 0, mtime: FIXED_MTIME }];
  }
  return zipSync(files, { level: 6 });
};
