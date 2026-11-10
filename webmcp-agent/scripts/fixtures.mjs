// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function startFixtures(firstPort = 0, secondPort = 0) {
  const servers = [createServer(), createServer()];
  const origins = [];
  for (const [index, server] of servers.entries()) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(index ? secondPort : firstPort, '127.0.0.1', resolve);
    });
    origins.push(`http://127.0.0.1:${server.address().port}`);
  }
  servers.forEach((server, index) => server.on('request', async (request, response) => {
    let filename = new URL(request.url, origins[index]).pathname.slice(1) || 'hints.html';
    if (filename === 'pizza-order/') filename += 'index.html';
    const demo = ['pizza-order/index.html', 'pizza-order/css/style.css', 'pizza-order/js/menu-data.js',
      'pizza-order/js/app.js', 'pizza-order/js/webmcp-tools.js'].includes(filename);
    if (!demo && !['hints.html', 'iframes.html', 'frame.html', 'dynamic.html', 'navigate.html', 'slow.html'].includes(filename)) { response.writeHead(404).end(); return; }
    try {
      const source = demo ? `../../demos/${filename}` : `../test/fixtures/${filename}`;
      const text = await readFile(new URL(source, import.meta.url), 'utf8');
      const contentType = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }).end(text.replaceAll('__OTHER_ORIGIN__', origins[1 - index]));
    } catch (error) { console.error(error); response.writeHead(500).end('Fixture read failed'); }
  }));
  return { origins, close: async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixtures = await startFixtures(8840, 8841);
  console.log(`Fixtures: ${fixtures.origins[0]}/hints.html and ${fixtures.origins[0]}/iframes.html`);
  process.once('SIGINT', () => { void fixtures.close(); });
}
