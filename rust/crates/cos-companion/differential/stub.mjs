#!/usr/bin/env node
// A loopback OpenAI-compatible provider for the Goal cases: every `POST .../chat/completions`
// is answered with one recorded decision and its body appended to the log file named by argv.
// Prints its base URL on the first line of stdout. Never reaches a real provider.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const log = process.argv[2];
const decision = { action: 'continue', reply: 'what about the tests' };
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (log) appendFileSync(log, JSON.stringify({ path: req.url, authorization: req.headers.authorization ?? null, body: JSON.parse(body || 'null') }) + '\n');
    const payload = JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(decision) } }] });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${server.address().port}/v1\n`));
