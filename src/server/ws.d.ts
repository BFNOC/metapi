declare module "ws" {
  import { EventEmitter } from "events";
  import { IncomingMessage } from "http";
  import { Duplex } from "stream";

  namespace WebSocket {
    type RawData = Buffer | ArrayBuffer | Buffer[];
  }

  class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    readonly readyState: number;
    constructor(address: string | URL, options?: any);
    close(code?: number, reason?: string | Buffer): void;
    send(data: any, cb?: (err?: Error) => void): void;
    send(data: any, options?: any, cb?: (err?: Error) => void): void;
    ping(data?: any, mask?: boolean, cb?: (err: Error) => void): void;
    pong(data?: any, mask?: boolean, cb?: (err: Error) => void): void;
    terminate(): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  class WebSocketServer extends EventEmitter {
    constructor(options?: any, callback?: () => void);
    close(cb?: (err?: Error) => void): void;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (client: WebSocket) => void): void;
    on(event: string, listener: (...args: any[]) => void): this;
    address(): any;
    clients: Set<WebSocket>;
  }

  type RawData = Buffer | ArrayBuffer | Buffer[];

  export default WebSocket;
  export { WebSocket, WebSocketServer, RawData };
}
