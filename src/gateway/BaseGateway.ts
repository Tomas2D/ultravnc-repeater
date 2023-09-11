import net, { Server, Socket } from "node:net";
import { EventEmitter } from "node:events";
import { Logger } from "../logger.js";
import { ConnectionId, VNCRepeaterOptions } from "../types.js";
import { RepeaterError } from "../error.js";
import { closeSocket, safeAsync } from "../utils.js";
import util from "node:util";
import { setKeepAliveInterval, setKeepAliveProbes } from "net-keepalive";
import { clearInterval } from "timers";

export abstract class BaseGateway extends EventEmitter {
  protected _server: Server | null = null;
  protected _logger: Logger;

  protected constructor(
    protected readonly _options: Pick<VNCRepeaterOptions, "socketTimeout"> & {
      port: number;
    },
    logger: Logger,
  ) {
    super();
    this._logger = logger.child({}, { msgPrefix: this._getLoggerPrefix() });
  }

  async start() {
    if (this._server) {
      this._logger.warn(`Server is already running.`);
      return;
    }

    this._server = net.createServer(
      {
        keepAlive: true,
        allowHalfOpen: false,
        pauseOnConnect: false,
      },
      safeAsync({
        handler: this._onConnection.bind(this),
        onError: (err) =>
          this._logger.error(err, `Error during connection (init phase)`),
      }),
    );

    await new Promise<void>((resolve) => {
      if (!this._server) {
        return resolve();
      }
      this._server.listen(this._options.port, () => {
        resolve();
      });
    });
  }

  async close() {
    if (!this._server) {
      this._logger.warn(`Server has not been even started!`);
      return;
    }
    await util.promisify(this._server.close.bind(this._server))();
  }

  protected _getLoggerPrefix() {
    return `[${this.constructor.name}]`;
  }

  protected async _waitForData(socket: Socket, size: number): Promise<string> {
    if (!socket.readable) {
      throw new RepeaterError("Socket is not readable!", { socket });
    }

    const readData = (): string | null => {
      const response: Buffer | null = socket.read(size);
      if (response && response.length >= size) {
        return response.toString();
      }
      return null;
    };

    return await new Promise((resolve, reject) => {
      const getData = () => {
        const data = readData();
        if (data !== null) {
          clearInterval(intervalId);
          resolve(data);
        }
      };
      getData();
      const intervalId = setInterval(getData, 100);
      socket.once("end", () => {
        clearInterval(intervalId);
        reject();
      });
    });
  }

  protected async _readHeader(socket: Socket, size: number) {
    this._logger.debug(`reading ${size}B from the socket`);

    let buffer = await this._waitForData(socket, size);
    const idx = buffer.indexOf("\0");
    if (idx >= 0) {
      buffer = buffer.substring(0, idx);
    }
    buffer = buffer.replace(/\s*$/, "");

    const [, id] = buffer.match(/^ID:(\w+)/) || [];

    return {
      id: id as string | undefined,
      buffer,
    };
  }

  static async hookup(a: Socket, b: Socket, id: ConnectionId) {
    await new Promise<void>((resolve, reject) => {
      const throwError = (originalError: Error) => {
        const error = new RepeaterError(
          `Error has occurred during hookup (ID:${id})`,
          {
            originalError,
          },
        );
        reject(error);
      };

      a.pipe(b).on("error", throwError).on("end", resolve);
      b.pipe(a).on("error", throwError).on("end", resolve);
    });
  }

  protected async _onConnection(socket: Socket) {
    if (this._options.socketTimeout) {
      this._logger.debug(
        `Setting timeout to ${this._options.socketTimeout} seconds.`,
      );
      socket.setTimeout(this._options.socketTimeout * 1000);
    }
    socket.setKeepAlive(true, 1000);
    setKeepAliveInterval(socket, 1000);
    setKeepAliveProbes(socket, 1);
    socket.on("error", (e) => {
      this._logger.error(e, "Socket error");
      closeSocket(socket);
    });
  }

  emit<T extends Record<string, any>>(
    eventName: string | symbol,
    body: T,
  ): boolean {
    return super.emit(eventName, body);
  }
}
