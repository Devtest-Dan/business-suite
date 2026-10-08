import { createServer, type Server } from "node:net";

/**
 * A tiny SMTP server for tests and local runs: it accepts every message
 * (no TLS, no auth) and keeps it, so a test can read what lib/mail.ts really
 * sent over SMTP. Not for anything but a developer's machine.
 */
export interface CaughtMail {
  from: string;
  to: string[];
  data: string;
}

export async function startSmtpCatcher(port = 0): Promise<{ port: number; messages: CaughtMail[]; close: () => Promise<void> }> {
  const messages: CaughtMail[] = [];
  const server: Server = createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current: CaughtMail = { from: "", to: [], data: "" };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 catcher ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          current.data = buffer.slice(0, end).replace(/\r\n\.\./g, "\r\n.");
          buffer = buffer.slice(end + 5);
          messages.push(current);
          current = { from: "", to: [], data: "" };
          inData = false;
          reply("250 OK: queued");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") reply("250 catcher");
        else if (verb === "MAIL") {
          current.from = line.replace(/^MAIL FROM:\s*/i, "");
          reply("250 OK");
        } else if (verb === "RCPT") {
          current.to.push(line.replace(/^RCPT TO:\s*/i, ""));
          reply("250 OK");
        } else if (verb === "DATA") {
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (verb === "QUIT") {
          reply("221 Bye");
          socket.end();
        } else if (verb === "RSET" || verb === "NOOP") reply("250 OK");
        else reply("502 Not implemented");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The decoded text of a caught message (quoted-printable soft breaks and =XX undone). */
export function mailText(m: CaughtMail): string {
  const body = m.data.split(/\r\n\r\n/).slice(1).join("\r\n\r\n");
  const bytes = body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(bytes, "latin1").toString("utf8");
}
