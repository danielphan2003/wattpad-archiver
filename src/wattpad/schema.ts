import * as Schema from "effect/Schema";

export const StoryId = Schema.String;

export const LibraryStory = Schema.Struct({
  id: StoryId,
  title: Schema.String,
  modifyDate: Schema.String,
  numParts: Schema.Int,
});
export interface LibraryStory extends Schema.Schema.Type<typeof LibraryStory> {}

export const LibraryPage = Schema.Struct({
  stories: Schema.Array(LibraryStory),
  nextUrl: Schema.optionalKey(Schema.String),
});

export const Part = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  modifyDate: Schema.String,
  photoUrl: Schema.optionalKey(Schema.String),
  dedication: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
    }),
  ),
  text_url: Schema.Struct({ text: Schema.String }),
  deleted: Schema.optionalKey(Schema.Boolean),
  draft: Schema.optionalKey(Schema.Boolean),
});
export interface Part extends Schema.Schema.Type<typeof Part> {}

export const Story = Schema.Struct({
  id: StoryId,
  title: Schema.String,
  createDate: Schema.String,
  modifyDate: Schema.String,
  description: Schema.String,
  url: Schema.String,
  cover: Schema.String,
  language: Schema.Struct({ id: Schema.Int, name: Schema.String }),
  user: Schema.Struct({ name: Schema.String, username: Schema.String }),
  completed: Schema.Boolean,
  numParts: Schema.Int,
  tags: Schema.Array(Schema.String),
  parts: Schema.Array(Part),
});
export interface Story extends Schema.Schema.Type<typeof Story> {}

/** Wattpad answers failures with HTTP 400 and this body. */
export const ApiFailure = Schema.Struct({
  error_type: Schema.String,
  message: Schema.optionalKey(Schema.String),
});

/** Fields requested per story. Counters (reads, votes) are left out so a story's EPUB only changes when its content does. */
export const STORY_FIELDS =
  "id,title,createDate,modifyDate,description,url,cover,language,user(name,username),completed,numParts,tags,parts(id,title,url,modifyDate,photoUrl,dedication(name,url),text_url,deleted,draft)";
export const LIBRARY_FIELDS = "stories(id,title,modifyDate,numParts),nextUrl";

export const isReadable = (part: Part) => part.deleted !== true && part.draft !== true;
