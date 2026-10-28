import { describe, expect, it } from "@effect/vitest";

import { extractImageUrls, isWattpadImageUrl, toXhtml } from "./html.ts";

const IMAGE = "https://img.wattpad.com/a.jpg";

describe("toXhtml", () => {
  it.each([
    {
      name: "closes void tags and decodes entities",
      html: "a&nbsp;b<br>c &amp; d",
      xhtml: "a&#xa0;b<br/>c &amp; d",
    },
    {
      name: "drops scripts with their content",
      html: "<p>hi<script>alert(1)</script></p>",
      xhtml: "<p>hi</p>",
    },
    {
      name: "drops event handlers and unknown attributes",
      html: '<p onclick="x()" data-p-id="1">hi</p>',
      xhtml: "<p>hi</p>",
    },
    {
      name: "unwraps tags outside the allowlist",
      html: "<center><b>hi</b></center>",
      xhtml: "<b>hi</b>",
    },
    {
      name: "unwraps links that are not http(s)",
      html: '<a href="javascript:x()">go</a>',
      xhtml: "go",
    },
    {
      name: "keeps http(s) links",
      html: '<a href="https://x.test/?a=1&b=2">go</a>',
      xhtml: '<a href="https://x.test/?a=1&amp;b=2">go</a>',
    },
    {
      name: "escapes alt text",
      html: `<img src="${IMAGE}" alt="a&b">`,
      xhtml: '<img src="images/img-1.jpg" alt="a&amp;b"/>',
    },
    {
      name: "drops images that were not downloaded",
      html: '<img src="https://img.wattpad.com/missing.jpg">',
      xhtml: "",
    },
  ])("$name", ({ html, xhtml }) => {
    expect(toXhtml(html, new Map([[IMAGE, "images/img-1.jpg"]]))).toBe(xhtml);
  });
});

describe("images", () => {
  it("collects Wattpad-hosted images once, in order, and ignores other hosts", () => {
    const html = `<img src="${IMAGE}"><img src="https://evil.example/t.png"><img src="https://d.wattpad.com/b.png"><img src="${IMAGE}">`;
    expect(extractImageUrls(html)).toEqual([IMAGE, "https://d.wattpad.com/b.png"]);
  });

  it.each([
    ["https://img.wattpad.com/a.jpg", true],
    ["https://wattpad.com/a.jpg", true],
    ["https://wattpad.com.evil.example/a.jpg", false],
    ["https://notwattpad.com/a.jpg", false],
    ["data:image/png;base64,AAAA", false],
    ["not a url", false],
  ])("isWattpadImageUrl(%s) is %s", (url, expected) => {
    expect(isWattpadImageUrl(url)).toBe(expected);
  });
});
