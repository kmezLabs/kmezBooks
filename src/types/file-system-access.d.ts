// Chrome's File System Access API parts that TypeScript's DOM library leaves
// out because other browsers don't ship them. https://wicg.github.io/file-system-access/

type FileSystemPermissionMode = 'read' | 'readwrite';

interface FileSystemHandlePermissionDescriptor {
  mode?: FileSystemPermissionMode;
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: FileSystemPermissionMode;
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads';
}

interface OpenFilePickerOptions {
  id?: string;
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads';
  types?: { description?: string; accept: Record<string, string[]> }[];
}

interface Window {
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}
