import { chmod, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import type { Logger } from "@myassistant/core";
import {
  type ControlEvent,
  type ControlRequest,
  encodeControlMessage,
  errorResponse,
  parseControlRequest,
  response,
} from "./control-protocol";

export interface ControlHandlers {
  status(): Promise<unknown>;
  chat(
    requestId: string,
    text: string,
    conversationId: string | undefined,
    emit: (controlEvent: ControlEvent) => void,
    signal: AbortSignal,
  ): Promise<string>;
  taskList(status?: string): Promise<unknown>;
  taskCheck(taskId: string): Promise<unknown>;
  taskCancel(taskId: string): Promise<boolean>;
  shutdown(): void;
}

export interface ControlServerOptions {
  socketPath: string;
  handlers: ControlHandlers;
  logger?: Logger;
}

export interface ControlServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly path: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ path: socketPath });
    const finish = (alive: boolean) => {
      socket.destroy();
      resolvePromise(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

export function createControlServer(options: ControlServerOptions): ControlServer {
  const socketPath = resolve(options.socketPath);
  const logger = options.logger;
  const controllers = new Map<Socket, AbortController>();
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let started = false;
  let stopping = false;

  const send = (socket: Socket, message: Parameters<typeof encodeControlMessage>[0]) => {
    if (socket.writable) {
      socket.write(encodeControlMessage(message));
    }
  };

  const processRequest = async (socket: Socket, request: ControlRequest): Promise<void> => {
    switch (request.type) {
      case "ping":
        send(socket, response(request.id, { pong: true, pid: process.pid }));
        return;
      case "status":
        send(socket, response(request.id, await options.handlers.status()));
        return;
      case "chat": {
        const controller = new AbortController();
        controllers.set(socket, controller);
        const emit = (controlEvent: ControlEvent) => send(socket, controlEvent);
        try {
          const text = await options.handlers.chat(
            request.id,
            request.text,
            request.conversationId,
            (controlEvent) => emit({ ...controlEvent, id: request.id }),
            controller.signal,
          );
          send(socket, response(request.id, { text }));
        } finally {
          controllers.delete(socket);
        }
        return;
      }
      case "task.list":
        send(socket, response(request.id, await options.handlers.taskList(request.status)));
        return;
      case "task.check":
        send(socket, response(request.id, await options.handlers.taskCheck(request.taskId)));
        return;
      case "task.cancel": {
        const cancelled = await options.handlers.taskCancel(request.taskId);
        send(socket, response(request.id, { cancelled }));
        return;
      }
      case "shutdown": {
        const payload = encodeControlMessage(response(request.id, { shuttingDown: true }));
        if (socket.writable) {
          socket.write(payload, () => setImmediate(() => options.handlers.shutdown()));
        } else {
          options.handlers.shutdown();
        }
        return;
      }
    }
  };

  const handleLine = async (socket: Socket, line: string): Promise<void> => {
    if (stopping) {
      return;
    }
    let request: ControlRequest;
    try {
      request = parseControlRequest(line);
    } catch (error) {
      send(socket, errorResponse("", errorMessage(error)));
      return;
    }

    try {
      await processRequest(socket, request);
    } catch (error) {
      logger?.error({ err: error, requestType: request.type }, "control request failed");
      send(socket, errorResponse(request.id, errorMessage(error)));
    }
  };

  const handleConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    let buffer = "";
    let queue: Promise<void> = Promise.resolve();

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          queue = queue
            .then(() => handleLine(socket, line))
            .catch((error) => logger?.error({ err: error }, "control connection failed"));
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      controllers.get(socket)?.abort(new Error("Control client disconnected."));
      controllers.delete(socket);
    });
    socket.on("error", (error) => {
      logger?.warn({ err: error }, "control socket error");
    });
  };

  return {
    path: socketPath,
    async start() {
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
      if (await canConnect(socketPath)) {
        throw new Error(`Another assistant is already listening on ${socketPath}.`);
      }
      await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });

      server = createServer({ allowHalfOpen: false }, handleConnection);
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (error: Error) => {
          server?.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server?.off("error", onError);
          resolvePromise();
        };
        server?.once("error", onError);
        server?.once("listening", onListening);
        server?.listen(socketPath);
      });
      await chmod(socketPath, 0o600);
      started = true;
      logger?.info({ socketPath }, "control socket listening");
    },
    async stop() {
      if (stopping || (!started && !server)) {
        return;
      }
      stopping = true;
      for (const controller of controllers.values()) {
        controller.abort(new Error("Control server stopping."));
      }
      controllers.clear();
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      const current = server;
      server = undefined;
      if (current) {
        await new Promise<void>((resolvePromise) => {
          current.close(() => resolvePromise());
        });
      }
      started = false;
      await unlink(socketPath).catch(() => undefined);
    },
  };
}
