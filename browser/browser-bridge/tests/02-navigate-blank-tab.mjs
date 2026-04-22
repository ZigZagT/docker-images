// New blank tab + navigate does not revert on switch (3 rounds)
// Uses browserscan.net — the URL that triggered the original bug
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const TEST_URL = 'https://www.browserscan.net/bot-detection';
const v = await connectViewer();
await v.waitFor('targetChanged');
v.clearEvents();

// Create blank tab — track by targetId, not URL (avoids ambiguity with accumulated tabs)
v.send({ type: 'newTab' });
const blankTc = await v.waitFor('targetChanged');
const blankId = blankTc.targetId;
v.clearEvents();

// Create second tab for switching
v.send({ type: 'newTab', url: 'https://example.com' });
const otherTc = await v.waitFor('targetChanged');
const otherId = otherTc.targetId;

// Switch back to the blank tab we created
v.send({ type: 'switchTab', targetId: blankId });
await v.waitFor('targetChanged');
v.clearEvents();

for (let round = 1; round <= 3; round++) {
  v.send({ type: 'navigate', url: TEST_URL });
  await v.waitFor('navigated');
  await delay(3000); v.clearEvents();

  // Verify the tab we created has the navigated URL
  const list = await httpGet('http://127.0.0.1:18800/json/list');
  const navUrl = list.find(t => t.id === blankId)?.url;
  if (!navUrl?.includes('browserscan')) fail('navigate-blank-tab', `round ${round}: tab URL is ${navUrl}`);

  // Switch away
  v.send({ type: 'switchTab', targetId: otherId });
  await v.waitFor('targetChanged');
  await delay(2000); v.clearEvents();

  // Switch back
  v.send({ type: 'switchTab', targetId: blankId });
  await v.waitFor('targetChanged');
  await delay(3000);

  const list2 = await httpGet('http://127.0.0.1:18800/json/list');
  const actualUrl = list2.find(t => t.id === blankId)?.url;
  const after = v.events.splice(0);
  const revert = after.find(m => m.type === 'navigated' && (m.url === 'about:blank' || m.url === 'chrome://newtab/'));

  if (revert) fail('navigate-blank-tab', `round ${round}: reverted to ${revert.url}`);
  if (actualUrl === 'about:blank' || actualUrl === 'chrome://newtab/') fail('navigate-blank-tab', `round ${round}: CDP reports ${actualUrl}`);
  console.log(`round ${round}: OK`);
}

pass('navigate-blank-tab');
v.close(); process.exit(0);
