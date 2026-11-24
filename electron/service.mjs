import { randomBytes, timingSafeEqual } from 'node:crypto';

export function createDesktopAuthorization(secret, getPort) {
  const expected = Buffer.from(secret);
  return (req) => {
    const value = req.headers['x-higher-music'];
    if (typeof value !== 'string' || req.headers.host !== `127.0.0.1:${getPort()}`) return false;
    const actual = Buffer.from(value);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}
export async function startDesktopService(createServer, options = {}) {
  const secret = randomBytes(32).toString('hex');
  let port;
  const server = createServer({ ...options, authorize: createDesktopAuthorization(secret, () => port) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  port = server.address().port;
  return {
    server, secret, origin: `http://127.0.0.1:${port}`,
    async stop() {
      if (!server.listening) return;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
