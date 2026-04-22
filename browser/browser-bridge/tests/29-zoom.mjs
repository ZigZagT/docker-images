// zoom applies CSS zoom to the active tab
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

v.send({ type: 'navigate', url: 'https://example.com' });
await v.waitFor('navigated');
await delay(2000);

// Zoom in
v.send({ type: 'zoom', level: 1.5 });
await delay(1000);

// Verify via internal state
v.send({ type: 'copyInternalState' });
const state = await v.waitFor('internalState');
if (state.data.zoomLevel !== 1.5) fail('zoom', 'expected 1.5, got: ' + state.data.zoomLevel);

// Reset zoom
v.send({ type: 'zoom', level: 1.0 });
await delay(500);

v.send({ type: 'copyInternalState' });
const state2 = await v.waitFor('internalState');
if (state2.data.zoomLevel !== 1.0) fail('zoom', 'reset: expected 1.0, got: ' + state2.data.zoomLevel);

pass('zoom');
v.close(); process.exit(0);
