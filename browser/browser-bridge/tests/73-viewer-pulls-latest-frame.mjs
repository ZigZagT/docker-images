// The viewer protocol is pull-based: the bridge stores the latest screencast
// frame, but raw viewers must not receive frames until they ask. Repeated asks
// without acknowledging/drawing the prior frame must not queue stale frames.
import { WebSocket } from 'ws';
import { delay, pass, fail } from './helpers.mjs';

const ws = new WebSocket('ws://127.0.0.1:6080/ws');
const frames = [];
const events = [];
await new Promise(r => ws.on('open', r));
ws.on('message', d => {
  const m = JSON.parse(d);
  if (m.type === 'frame') frames.push(m);
  else events.push(m);
});

// No frame should be pushed before a viewer request.
await delay(1200);
if (frames.length !== 0) {
  fail('viewer-pulls-latest-frame', 'received unsolicited frame before request');
}

ws.send(JSON.stringify({ type: 'requestFrame' }));
for (let i = 0; i < 30 && frames.length === 0; i++) await delay(100);
if (frames.length !== 1) {
  fail('viewer-pulls-latest-frame', 'expected exactly one frame after request, got ' + frames.length);
}
const firstId = frames[0].frameId;
if (typeof firstId !== 'number') {
  fail('viewer-pulls-latest-frame', 'frame missing numeric frameId');
}

// Duplicate requests while the first frame is still "in flight" are ignored.
ws.send(JSON.stringify({ type: 'requestFrame' }));
ws.send(JSON.stringify({ type: 'requestFrame' }));
await delay(1000);
if (frames.length !== 1) {
  fail('viewer-pulls-latest-frame', 'duplicate requests queued extra frames while in flight');
}

// After draw acknowledgment, a request should wait for a newer frame rather
// than replaying the same cached frame forever on static pages.
ws.send(JSON.stringify({ type: 'frameDrawn' }));
ws.send(JSON.stringify({ type: 'requestFrame' }));
await delay(1000);
if (frames.some((f, i) => i > 0 && f.frameId === firstId)) {
  fail('viewer-pulls-latest-frame', 'server replayed same cached frame after draw');
}

ws.close();
pass('viewer-pulls-latest-frame');
process.exit(0);
