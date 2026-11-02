// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isPairingToken, parseStartRequest, parseToolResults } from '../src/lib/llm/copilot-protocol.js';
import { CopilotBridge, ServiceError } from './bridge.js';

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    return Promise.reject(new ServiceError(415, 'Content-Type must be application/json.'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new ServiceError(413, 'Copilot request exceeds the 1 MiB limit.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (bytes > MAX_BODY_BYTES) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ServiceError(400, 'Invalid JSON request.')); }
    });
  });
}

function respond(response: ServerResponse, status: number, body?: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

export function createCompanionServer(bridge: CopilotBridge, token: string) {
  if (!isPairingToken(token)) throw new Error('A strong companion pairing token is required (not a GitHub credential).');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const server = createServer((request, response) => {
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    void (async () => {
      if (request.headers.host !== `127.0.0.1:${request.socket.localPort}`) {
        throw new ServiceError(403, 'Only loopback requests with the correct Host are allowed.');
      }
      const origin = request.headers.origin;
      if (origin) {
        if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw new ServiceError(403, 'Origin is not an extension.');
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        respond(response, 204);
        return;
      }
      const authorization = Buffer.from(request.headers.authorization ?? '');
      if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
        throw new ServiceError(401, 'Invalid companion pairing token. Copy the token from the service terminal.');
      }
      const path = request.url;
      if (request.method === 'GET' && path === '/models') {
        respond(response, 200, { models: await bridge.listModels() });
      } else if (request.method === 'POST' && path === '/sessions') {
        const value = await readBody(request);
        let parsed;
        try { parsed = parseStartRequest(value); }
        catch (error) { throw new ServiceError(400, error instanceof Error ? error.message : 'Invalid conversation.'); }
        respond(response, 200, await bridge.start(parsed, controller.signal));
      } else {
        const match = /^\/sessions\/([0-9a-f-]{36})(\/results)?$/.exec(path ?? '');
        if (match && request.method === 'DELETE' && !match[2]) {
          await bridge.close(match[1]);
          respond(response, 204);
        } else if (match && request.method === 'POST' && match[2]) {
          const value = await readBody(request);
          let results;
          try { results = parseToolResults(value); }
          catch (error) { throw new ServiceError(400, error instanceof Error ? error.message : 'Invalid tool results.'); }
          respond(response, 200, await bridge.reply(match[1], results, controller.signal));
        } else throw new ServiceError(404, 'Unknown companion endpoint.');
      }
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ServiceError) respond(response, error.status, { error: error.message });
      else {
        console.error('Copilot companion operation failed:', error instanceof Error ? error.name : 'UnknownError');
        respond(response, 503, { error: 'Copilot CLI request failed. Check CLI installation, sign-in, account policy, and service connectivity; then restart the companion.' });
      }
    });
  });
  server.requestTimeout = 150_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 32;
  return server;
}
