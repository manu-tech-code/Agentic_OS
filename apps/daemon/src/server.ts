import { createDecisionEngine, LlmReasoningBrain, NovaBrain, type ClientEvent, type ServerEvent } from '@nova/core';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from './config.ts';
import { createPlatform } from './platform.ts';

const hasKey = Boolean(config.gatewayKey);
const engine = createDecisionEngine({
  engine: config.engine,
  fallback: config.fallback,
  timeoutMs: config.timeoutMs,
  jevModel: config.jevModel,
  hasGatewayKey: hasKey,
});
const reasoning = hasKey && config.brainModel ? new LlmReasoningBrain(config.brainModel) : null;

const clients = new Set<WebSocket>();
const broadcast = (event: ServerEvent) => {
  const data = JSON.stringify(event);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
};

const nova = new NovaBrain({ engine, reasoning, platform: createPlatform(), wakeWords: config.wakeWords, emit: broadcast });
await nova.init();

// Any web page can try to reach localhost - only accept our own shells.
const ALLOWED_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/;

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: config.port,
  verifyClient: ({ origin }: { origin?: string }) => !origin || ALLOWED_ORIGIN.test(origin),
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(nova.hello()));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', async (raw) => {
    let event: ClientEvent;
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (event.type === 'utterance') await nova.handle(event.text, event.source);
    else if (event.type === 'speech-finished') nova.speechFinished();
    else if (event.type === 'cancel') nova.cancel();
  });
});

console.log(`
  Nova daemon  ws://127.0.0.1:${config.port}
  System 1     ${engine.name}
  System 2     ${reasoning?.name ?? '(none - set AI_GATEWAY_API_KEY + NOVA_BRAIN_MODEL)'}
  Apps found   ${nova.apps.length}
  Wake words   ${config.wakeWords.join(', ')}
`);
