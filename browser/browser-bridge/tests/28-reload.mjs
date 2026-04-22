// reload triggers a page reload on the active tab
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

v.send({ type: 'navigate', url: 'https://example.com' });
await v.waitFor('navigated');
await delay(2000); v.clearEvents();

// Reload — should trigger loading events
v.send({ type: 'reload' });

// Wait for loading start/stop cycle
const loadStart = await v.waitFor('loading');
if (!loadStart.loading) fail('reload', 'expected loading=true');

pass('reload');
v.close(); process.exit(0);
