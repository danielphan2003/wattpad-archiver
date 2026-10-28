import { describe, expect, it } from "@effect/vitest";
import { strFromU8, unzipSync } from "fflate";

import { buildEpub, type EpubInput } from "./epub.ts";
import { makePart, makeStory } from "./fixtures.testkit.ts";

const png = (path: string) => ({
  path,
  mediaType: "image/png",
  bytes: new Uint8Array([137, 80, 78, 71]),
});

const input = (overrides: Partial<EpubInput> = {}): EpubInput => {
  const story = makeStory("5", { title: 'A & B <"C">' });
  return {
    story,
    chapters: story.parts.map((part) => ({ part, body: `<p>${part.title} text</p>` })),
    cover: png("images/cover.png"),
    images: [png("images/img-1.png")],
    ...overrides,
  };
};

const unzip = (bytes: Uint8Array) =>
  Object.fromEntries(
    Object.entries(unzipSync(bytes)).map(([name, data]) => [name, strFromU8(data)]),
  );

describe("buildEpub", () => {
  it("writes a conforming container: mimetype first and stored, every manifest file present", () => {
    const bytes = buildEpub(input());
    const view = new DataView(bytes.buffer, bytes.byteOffset);

    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
    const nameLength = view.getUint16(26, true);
    expect(strFromU8(bytes.subarray(30, 30 + nameLength))).toBe("mimetype");

    const files = unzip(bytes);
    expect(files.mimetype).toBe("application/epub+zip");
    const hrefs = [...files["OEBPS/content.opf"]!.matchAll(/ href="([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    expect(hrefs.length).toBeGreaterThan(5);
    for (const href of hrefs) expect(files).toHaveProperty([`OEBPS/${href}`]);
  });

  it("escapes metadata, orders the spine, and marks the cover", () => {
    const opf = unzip(buildEpub(input()))["OEBPS/content.opf"]!;

    expect(opf).toContain("<dc:title>A &amp; B &lt;&quot;C&quot;&gt;</dc:title>");
    expect(opf).toContain('<dc:identifier id="uid">wp5</dc:identifier>');
    expect(opf).toContain('properties="cover-image"');
    expect(opf.match(/<dc:subject>/g)).toHaveLength(2);
    expect(opf.indexOf('idref="c51"')).toBeLessThan(opf.indexOf('idref="c52"'));
  });

  it("keeps a chapter that failed to download as a visible placeholder", () => {
    const story = makeStory("5");
    const files = unzip(
      buildEpub(
        input({
          chapters: [
            { part: story.parts[0]!, body: "<p>fine</p>" },
            { part: story.parts[1]!, body: undefined },
          ],
        }),
      ),
    );

    expect(files["OEBPS/chapter-52.xhtml"]).toContain("could not be downloaded");
    expect(files["OEBPS/nav.xhtml"]).toContain("chapter-52.xhtml");
  });

  it.each([
    { id: 1, code: "en" },
    { id: 19, code: "vi" },
    { id: 9999, code: "und" },
  ])("tags language id $id as $code", ({ id, code }) => {
    const story = makeStory("5", { language: { id, name: "Any" } });
    const files = unzip(
      buildEpub(input({ story, chapters: [{ part: makePart(1), body: "<p>x</p>" }] })),
    );
    expect(files["OEBPS/content.opf"]).toContain(`<dc:language>${code}</dc:language>`);
  });

  it("produces identical bytes for identical input", () => {
    expect(buildEpub(input())).toEqual(buildEpub(input()));
  });
});
