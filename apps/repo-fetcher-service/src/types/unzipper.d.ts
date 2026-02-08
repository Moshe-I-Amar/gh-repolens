declare module 'unzipper' {
  import type { Readable } from 'stream';

  export type Entry = {
    type: 'File' | 'Directory' | string;
    path: string;
    autodrain(): void;
    stream(): Readable;
  };

  export type OpenedZip = {
    files: Entry[];
  };

  export const Open: {
    file(path: string): Promise<OpenedZip>;
  };

  const unzipper: {
    Open: typeof Open;
  };

  export default unzipper;
}
