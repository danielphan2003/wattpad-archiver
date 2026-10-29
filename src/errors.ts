import * as Schema from "effect/Schema";

export class WattpadAuthError extends Schema.TaggedError<WattpadAuthError>()("WattpadAuthError", {
  operation: Schema.String,
}) {
  override get message(): string {
    return "Wattpad rejected the token. Log in again and copy a fresh `token` cookie.";
  }
}

export class WattpadNotFoundError extends Schema.TaggedError<WattpadNotFoundError>()(
  "WattpadNotFoundError",
  { operation: Schema.String, target: Schema.String },
) {
  override get message(): string {
    return `Wattpad has no ${this.target}.`;
  }
}

export class WattpadRequestError extends Schema.TaggedError<WattpadRequestError>()(
  "WattpadRequestError",
  {
    operation: Schema.String,
    status: Schema.Int,
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return `Wattpad ${this.operation} failed with status ${this.status}${
      this.detail === undefined ? "" : `: ${this.detail}`
    }.`;
  }
}

export class WattpadResponseError extends Schema.TaggedError<WattpadResponseError>()(
  "WattpadResponseError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Wattpad ${this.operation} returned an unreadable response or the connection failed.`;
  }
}

export class CredentialsError extends Schema.TaggedError<CredentialsError>()("CredentialsError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export class ArchiveWriteError extends Schema.TaggedError<ArchiveWriteError>()(
  "ArchiveWriteError",
  { operation: Schema.String, path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} ${this.path}.`;
  }
}

export const WattpadError = Schema.Union([
  WattpadAuthError,
  WattpadNotFoundError,
  WattpadRequestError,
  WattpadResponseError,
]);
export type WattpadError = typeof WattpadError.Type;
