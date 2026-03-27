// Second viewer receives current active tab on connect
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v1 = await connectViewer();
const boot1 = await v1.waitFor('targetChanged');
v1.clearEvents();

// Navigate to a URL — wait for either navigated or targetChanged
v1.send({ type: 'navigate', url: 'https://example.com' });
await v1.waitFor('navigated');
await delay(1000);

// Connect second viewer
const v2 = await connectViewer();
const boot2 = await v2.waitFor('targetChanged');

if (boot2.url?.includes('example.com')) pass('two-viewers-same-tab');
else fail('two-viewers-same-tab', 'viewer 2 got: ' + boot2.url + ', expected example.com');
v1.close(); v2.close(); process.exit(0);
