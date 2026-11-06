/** Raw file content accepted by the Bot API. */
export type InputFileSource = Blob | Uint8Array | ArrayBuffer;

/** File content with an explicit upload name (and optional MIME type). */
export interface NamedInputFile {
  readonly data: InputFileSource;
  readonly filename: string;
  readonly contentType?: string;
}

/**
 * The Bot API `InputFile` type: content uploaded as multipart/form-data.
 * Plain strings are never files: they are `file_id`s or URLs and go out as JSON.
 */
export type InputFile = InputFileSource | NamedInputFile;

const isSource = (v: unknown): v is InputFileSource =>
  v instanceof Blob || v instanceof Uint8Array || v instanceof ArrayBuffer;

export function isInputFile(value: unknown): value is InputFile {
  if (isSource(value)) return true;
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { data?: unknown; filename?: unknown };
  return typeof candidate.filename === 'string' && isSource(candidate.data);
}
