// Navigate from one viewer broadcasts navigated event to both viewers
import { connectViewer, delay, pass, fail } from './helpers.mjs';

// Content-aware wait: finds a navigated event matching the URL substring.
// Ignores stale navigated events from prior tests' tabs still loading.
function waitForNav(viewer, urlPart, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for navigated: ' + urlPart)), timeout);
    const c = setInterval(() => {
      const i = viewer.events.findIndex(m => m.type === 'navigated' && m.url?.includes(urlPart));
      if (i >= 0) { clearTimeout(t); clearInterval(c); resolve(viewer.events.splice(i, 1)[0]); }
    }, 100);
  });
}

const v1 = await connectViewer();
await v1.waitFor('targetChanged'); v1.clearEvents();

const v2 = await connectViewer();
await v2.waitFor('targetChanged'); v2.clearEvents();

// v1 navigates
v1.send({ type: 'navigate', url: 'https://example.com' });
const n1 = await waitForNav(v1, 'example.com');
const n2 = await waitForNav(v2, 'example.com');

// Now v2 navigates
v1.clearEvents(); v2.clearEvents();
v2.send({ type: 'navigate', url: 'https://www.iana.org/' });
await waitForNav(v2, 'iana.org');
const n1b = await waitForNav(v1, 'iana.org');

pass('navigate-broadcasts-both');
v1.close(); v2.close(); process.exit(0);
