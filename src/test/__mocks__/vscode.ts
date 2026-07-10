export class Uri {
  constructor(public readonly raw: string) {}
  toString(): string {
    return this.raw;
  }
  static parse(value: string): Uri {
    return new Uri(value);
  }
  static file(value: string): Uri {
    return new Uri(value);
  }
  get fsPath(): string {
    return this.raw;
  }
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
}

export class WorkspaceEdit {
  private readonly replacements = new Map<string, Array<{ range: Range; newText: string }>>();
  replace(uri: Uri, range: Range, newText: string): void {
    const key = uri.toString();
    const list = this.replacements.get(key) ?? [];
    list.push({ range, newText });
    this.replacements.set(key, list);
  }
  get(uri: Uri): Array<{ range: Range; newText: string }> {
    return this.replacements.get(uri.toString()) ?? [];
  }
}

export class TextDocument {
  constructor(public readonly uri: Uri, private readonly text: string) {}
  getText(): string {
    return this.text;
  }
  positionAt(offset: number): Position {
    return new Position(0, offset);
  }
}

export const workspace = {
  openTextDocument: async (uri: Uri): Promise<TextDocument> =>
    new TextDocument(uri, ""),
  applyEdit: async (_edit: WorkspaceEdit): Promise<boolean> => true,
};

export const window = {};
export const commands = { executeCommand: async () => undefined };
export const ConfigurationTarget = { Workspace: 2, Global: 1 };