// normalizeUrl: bare domain, empty, explicit scheme
// Verifies each via the tab's actual URL in Chrome's /json/list
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

const cases = [
  ['https://example.com', 'example.com'],
  ['example.com', 'example.com'],
  ['http://httpbin.org/get', 'httpbin.org'],
  ['', 'about:blank'],
];

for (const [input, expected] of cases) {
  v.clearEvents();
  v.send({ type: 'newTab', url: input });
  const tc = await v.waitFor('targetChanged');
  await delay(2000);

  // Check the specific tab we just created by targetId
  const list = await httpGet('http://127.0.0.1:18800/json/list');
  const tab = list.find(t => t.id === tc.targetId);
  if (!tab?.url?.includes(expected)) {
    fail('normalize-url', 'input "' + input + '": got "' + tab?.url + '", expected "' + expected + '"');
  }
}

pass('normalize-url');
v.close(); process.exit(0);
