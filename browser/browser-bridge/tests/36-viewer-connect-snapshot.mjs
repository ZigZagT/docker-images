// Bridge MUST send a complete state snapshot to a newly connecting
// viewer. Without this, the viewer shows partial UI (URL bar populated
// but no tabs visible, no extensions, no rendered content).
//
// Required snapshot within 2 seconds of connect:
//   - targetChanged: which tab is active + URL
//   - tabs:          list of all tabs (so tab bar is populated)
//   - extensions:    extension icons (toolbar)
//   - profileStatus: account state (avatar)
//   - frame:         at least one frame (so canvas is not blank)
import { WebSocket } from 'ws';
import { delay, pass, fail } from './helpers.mjs';

const ws = new WebSocket('ws://127.0.0.1:6080/ws');
await new Promise(r => ws.on('open', r));

const received = new Set();
ws.on('message', d => {
  const m = JSON.parse(d);
  received.add(m.type);
});

await delay(2500);
ws.close();

const required = ['targetChanged', 'tabs', 'extensions', 'profileStatus', 'frame'];
const missing = required.filter(t => !received.has(t));

if (missing.length > 0) {
  fail('viewer-connect-snapshot', 'missing on connect: ' + missing.join(', ') + ' (received: ' + [...received].join(', ') + ')');
}

pass('viewer-connect-snapshot');
process.exit(0);
