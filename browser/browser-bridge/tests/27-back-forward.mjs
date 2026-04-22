// back/forward commands navigate the active tab's history
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

// Navigate to two different pages to build history
v.send({ type: 'navigate', url: 'https://example.com' });
await v.waitFor('navigated');
await delay(2000); v.clearEvents();

v.send({ type: 'navigate', url: 'https://www.iana.org/' });
await v.waitFor('navigated');
await delay(2000);

const list1 = await httpGet('http://127.0.0.1:18800/json/list');
const activeId = list1.find(t => t.type === 'page')?.id;
const url1 = list1.find(t => t.id === activeId)?.url;
if (!url1?.includes('iana.org')) fail('back-forward', 'expected iana.org, got: ' + url1);
v.clearEvents();

// Back — should go to example.com
v.send({ type: 'back' });
await delay(3000);

const list2 = await httpGet('http://127.0.0.1:18800/json/list');
const url2 = list2.find(t => t.id === activeId)?.url;
if (!url2?.includes('example.com')) fail('back-forward', 'back: expected example.com, got: ' + url2);

// Forward — should go back to iana.org
v.clearEvents();
v.send({ type: 'forward' });
await delay(3000);

const list3 = await httpGet('http://127.0.0.1:18800/json/list');
const url3 = list3.find(t => t.id === activeId)?.url;
if (!url3?.includes('iana.org')) fail('back-forward', 'forward: expected iana.org, got: ' + url3);

pass('back-forward');
v.close(); process.exit(0);
