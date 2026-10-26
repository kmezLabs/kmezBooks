// Test helper: a minimal stand-in for Chrome's FileSystemDirectoryHandle.
// Like Chrome, a writable collects data in a swap buffer and only replaces
// the file on close().
export class FakeFile {
  data = new Uint8Array();
  lastModified = 0;
}

export class FakeDir {
  files = new Map<string, FakeFile>();
  clock = 1_000;
  failNextWrite = false;

  /** Simulate another program or device changing the file. */
  touchExternally(name: string, data: Uint8Array<ArrayBuffer>) {
    const f = this.files.get(name)!;
    f.data = data;
    f.lastModified = ++this.clock;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let file = this.files.get(name);
    if (!file) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      file = new FakeFile();
      file.lastModified = ++this.clock;
      this.files.set(name, file);
    }
    const f = file;
    return {
      getFile: async () => new File([f.data], name, { lastModified: f.lastModified }),
      createWritable: async () => {
        let swap = new Uint8Array();
        return {
          write: async (bytes: Uint8Array) => {
            if (this.failNextWrite) {
              this.failNextWrite = false;
              throw new DOMException('disk full', 'QuotaExceededError');
            }
            swap = bytes.slice();
          },
          close: async () => {
            f.data = swap;
            f.lastModified = ++this.clock;
          },
          abort: async () => {},
        };
      },
    };
  }
}

export const asDir = (d: FakeDir) => d as unknown as FileSystemDirectoryHandle;
