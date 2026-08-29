import type { FastifyReply } from "fastify";

export interface SseWriter {
  send(event: unknown): void;
  end(): void;
  abort(): void;
  startHeartbeat(fn: () => unknown): () => void;
}

export function sseReply(reply: FastifyReply): SseWriter {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let closed = false;
  const write = (s: string): void => {
    if (!closed) reply.raw.write(s);
  };
  return {
    send(event: unknown): void {
      write(`data: ${JSON.stringify(event)}\n\n`);
    },
    end(): void {
      if (closed) return;
      write("data: [DONE]\n\n");
      reply.raw.end();
      closed = true;
    },
    abort(): void {
      if (closed) return;
      reply.raw.end();
      closed = true;
    },
    startHeartbeat(fn: () => unknown): () => void {
      const timer = setInterval(() => {
        if (!closed) fn();
      }, 15_000);
      return () => clearInterval(timer);
    },
  };
}
