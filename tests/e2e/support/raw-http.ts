import { connect } from 'node:net';

export interface RawReply {
  readonly status: number;
  readonly body: string;
}

/**
 * Writes the request bytes as given, for what fetch cannot send: a GET with a body, or a chunked body with no
 * chunk at all. The connection closes after the answer.
 */
export const rawRequest = (baseUrl: string, head: string[], body = ''): Promise<RawReply> => {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number.parseInt(port, 10), hostname);
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const [status = '0'] = /^HTTP\/1\.1 (\d{3})/.exec(text)?.slice(1) ?? [];
      resolve({ status: Number.parseInt(status, 10), body: text.slice(text.indexOf('\r\n\r\n') + 4) });
    });
    socket.write(`${[...head, `Host: ${hostname}:${port}`, 'Connection: close'].join('\r\n')}\r\n\r\n${body}`);
  });
};
