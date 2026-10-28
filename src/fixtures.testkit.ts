import type { Part, Story } from "./wattpad/schema.ts";

export const makePart = (id: number, overrides: Partial<Part> = {}): Part => ({
  id,
  title: `Chapter ${id}`,
  url: `https://www.wattpad.com/${id}`,
  modifyDate: "2026-01-01T00:00:00Z",
  text_url: { text: `https://www.wattpad.com/apiv2/?m=storytext&id=${id}&page=` },
  ...overrides,
});

export const makeStory = (id: string, overrides: Partial<Story> = {}): Story => {
  const parts = overrides.parts ?? [makePart(Number(id) * 10 + 1), makePart(Number(id) * 10 + 2)];
  return {
    id,
    title: `Story ${id}`,
    createDate: "2025-12-31T10:00:00Z",
    modifyDate: "2026-01-01T00:00:00Z",
    description: "A story.\nWith two lines.",
    url: `https://www.wattpad.com/story/${id}`,
    cover: "https://img.wattpad.com/cover/cover.jpg",
    language: { id: 1, name: "English" },
    user: { name: "Ada Author", username: "ada" },
    completed: false,
    numParts: parts.length,
    tags: ["one", "two"],
    ...overrides,
    parts,
  };
};
