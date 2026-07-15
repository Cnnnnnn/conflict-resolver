type Disposable = { dispose(): void };

function createEvent<T>(): {
  (listener: (event: T) => unknown): Disposable;
  fire(event: T): void;
} {
  const listeners = new Set<(event: T) => unknown>();
  const event = ((listener: (event: T) => unknown) => {
    listeners.add(listener);
    return {
      dispose: () => {
        listeners.delete(listener);
      },
    };
  }) as {
    (listener: (event: T) => unknown): Disposable;
    fire(event: T): void;
  };
  event.fire = (value: T) => {
    for (const listener of [...listeners]) {
      listener(value);
    }
  };
  return event;
}

export class Uri {
  constructor(public readonly raw: string) {}
  toString(): string {
    return this.raw;
  }
  static parse(value: string): Uri {
    return new Uri(value);
  }
  static file(value: string): Uri {
    return new Uri(value.startsWith("file://") ? value : `file://${value}`);
  }
  get fsPath(): string {
    return this.raw.replace(/^file:\/\//u, "");
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

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();

  readonly event = ((listener: (event: T) => unknown) => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }) as unknown as {
    (listener: (event: T) => unknown): Disposable;
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class TextEditorDecorationType {
  dispose(): void {}
}

export class StatusBarItem {
  text = "";
  tooltip?: string;
  command?: string;
  show(): void {}
  hide(): void {}
  dispose(): void {}
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class TextDocument {
  readonly eol = EndOfLine.LF;
  constructor(public readonly uri: Uri, private readonly text: string) {}
  getText(): string {
    return this.text;
  }
  positionAt(offset: number): Position {
    return new Position(0, offset);
  }
  lineAt(line: number): { range: Range; text: string } {
    const lines = this.text.split("\n");
    const content = lines[line] ?? "";
    return {
      text: content,
      range: new Range(new Position(line, 0), new Position(line, content.length)),
    };
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable {
    registeredCommands.set(id, handler);
    return {
      dispose: () => {
        registeredCommands.delete(id);
      },
    };
  },
  executeCommand: async () => undefined,
  getCommands: async (_includeInternal?: boolean) => [
    "merge-conflict.accept.current",
    "merge-conflict.accept.incoming",
    "merge-conflict.accept.both",
  ],
};

const configuration = {
  get<T>(_key: string, defaultValue?: T): T | undefined {
    return defaultValue;
  },
  update: async () => undefined,
};

export const workspace = {
  workspaceFolders: [{ uri: Uri.file("/repo"), name: "repo", index: 0 }],
  textDocuments: [] as TextDocument[],
  getConfiguration: () => configuration,
  openTextDocument: async (uri: Uri): Promise<TextDocument> => new TextDocument(uri, ""),
  applyEdit: async (_edit: WorkspaceEdit): Promise<boolean> => true,
  createFileSystemWatcher: () => ({
    onDidChange: createEvent<unknown>(),
    onDidCreate: createEvent<unknown>(),
    onDidDelete: createEvent<unknown>(),
    dispose: () => {},
  }),
  onDidOpenTextDocument: createEvent<unknown>(),
  onDidCloseTextDocument: createEvent<unknown>(),
  onDidChangeTextDocument: createEvent<unknown>(),
  onDidSaveTextDocument: createEvent<unknown>(),
  onDidChangeWorkspaceFolders: createEvent<unknown>(),
  onDidChangeConfiguration: createEvent<{ affectsConfiguration: (section: string) => boolean }>(),
};

export const extensions = {
  getExtension: () => undefined,
};

export const window = {
  visibleTextEditors: [] as Array<{
    document: TextDocument;
    revealRange: () => void;
    setDecorations: () => void;
  }>,
  activeTextEditor: undefined as
    | {
        document: TextDocument;
        selection: { active: Position };
        revealRange: () => void;
        setDecorations: () => void;
      }
    | undefined,
  createTreeView: () => ({
    badge: undefined as { value: number; tooltip: string } | undefined,
    message: undefined as string | undefined,
    onDidChangeVisibility: createEvent<{ visible: boolean }>(),
  }),
  createTextEditorDecorationType: () => new TextEditorDecorationType(),
  createStatusBarItem: () => new StatusBarItem(),
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  onDidChangeActiveTextEditor: createEvent<unknown>(),
};

export const ConfigurationTarget = { Workspace: 2, Global: 1 };
