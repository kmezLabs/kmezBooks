// Test helper: a minimal stand-in for Chrome's FileSystemDirectoryHandle.
// Like Chrome, a writable collects data in a swap buffer and only replaces
// the file on close().

export class FakeFile {
  data = new Uint8Array();
  lastModified = 0;
}

let clock = 1_000;
const tick = () => ++clock;

export class FakeDir {
  files = new Map<string, FakeFile>();
  dirs = new Map<string, FakeDir>();
  failNextWrite = false;
  readonly kind = 'directory';

  constructor(readonly name = 'folder') {}

  /** Simulate another program or device changing the file. */
  touchExternally(name: string, data: Uint8Array<ArrayBuffer>) {
    const f = this.files.get(name)!;
    f.data = data;
    f.lastModified = tick();
  }

  text(name: string): string {
    return new TextDecoder().decode(this.files.get(name)!.data);
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let file = this.files.get(name);
    if (!file) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      file = new FakeFile();
      file.lastModified = tick();
      this.files.set(name, file);
    }
    return this.fileHandle(name, file);
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      dir = new FakeDir(name);
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async removeEntry(name: string) {
    if (!this.files.delete(name) && !this.dirs.delete(name)) {
      throw new DOMException('not found', 'NotFoundError');
    }
  }

  async isSameEntry(other: unknown) {
    return other === this;
  }

  async *entries(): AsyncGenerator<[string, unknown]> {
    for (const [name, file] of this.files) yield [name, this.fileHandle(name, file)];
    for (const [name, dir] of this.dirs) yield [name, dir];
  }

  private fileHandle(name: string, f: FakeFile) {
    return {
      kind: 'file' as const,
      name,
      getFile: async () => new File([f.data], name, { lastModified: f.lastModified }),
      createWritable: async () => {
        let swap = new Uint8Array();
        return {
          write: async (bytes: Uint8Array | string) => {
            if (this.failNextWrite) {
              this.failNextWrite = false;
              throw new DOMException('disk full', 'QuotaExceededError');
            }
            swap = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes.slice();
          },
          close: async () => {
            f.data = swap;
            f.lastModified = tick();
          },
          abort: async () => {},
        };
      },
    };
  }
}

export const asDir = (d: FakeDir) => d as unknown as FileSystemDirectoryHandle;
