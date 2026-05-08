// Run all tests sequentially. Each test is a separate process to isolate state.
// Before running: disconnect external viewers and clean accumulated tabs so
// tests are not affected by the user's browser or prior test runs.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';

const dir = path.dirname(fileURLToPath(import.meta.url));

function httpGet(u) {
  return new Promise((r, j) => http.get(u, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { try { r(JSON.parse(d)); } catch { r(d); } });
  }).on('error', j));
}

async function setup() {
  // 1. Disconnect all existing viewers by connecting, requesting internal
  //    state, then closing. The bridge doesn't expose a "kick viewers"
  //    command, but restarting the bridge would work — instead we just
  //    accept that external viewers may reconnect after our test connects.
  //    The real fix: external viewers no longer send harmful commands
  //    (popstate/back/forward removed from index.html).

  // 2. Clean accumulated tabs — keep only one
  try {
    const list = await httpGet('http://127.0.0.1:18800/json/list');
    const pages = list.filter(t => t.type === 'page');
    for (const t of pages.slice(1)) {
      await new Promise(r => http.get('http://127.0.0.1:18800/json/close/' + t.id, () => r()).on('error', () => r()));
    }
    if (pages.length > 1) await new Promise(r => setTimeout(r, 1000));
    console.log('setup: cleaned ' + (pages.length - 1) + ' tabs, kept 1');
  } catch (err) {
    console.log('setup: tab cleanup failed:', err.message);
  }
}

await setup();

const filterArg = process.argv[2] || '';
const filters = filterArg ? filterArg.split(',').map(s => s.trim()) : [];

const tests = fs.readdirSync(dir)
  .filter(f => /^\d+-.*\.mjs$/.test(f))
  .filter(f => filters.length === 0 || filters.some(p => f.includes(p)))
  .sort();

let passed = 0;
let failed = 0;
const failures = [];

async function cleanTabs() {
  try {
    const list = await httpGet('http://127.0.0.1:18800/json/list');
    const pages = list.filter(t => t.type === 'page');
    for (const t of pages.slice(1)) {
      await new Promise(r => http.get('http://127.0.0.1:18800/json/close/' + t.id, () => r()).on('error', () => r()));
    }
    if (pages.length > 1) await new Promise(r => setTimeout(r, 500));
  } catch {}
}

for (const test of tests) {
  await cleanTabs();
  const file = path.join(dir, test);
  try {
    const out = execFileSync('node', [file], {
      timeout: 120000,
      cwd: path.join(dir, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = out.toString().trim();
    const lines = stdout.split('\n');
    const passLine = lines.find(l => l.startsWith('PASS:'));
    if (passLine) {
      console.log(passLine);
      passed++;
    } else {
      console.log('FAIL:', test, '(no PASS output)');
      console.log('  stdout:', stdout);
      failed++;
      failures.push(test);
    }
  } catch (err) {
    const stderr = err.stderr?.toString().trim() || '';
    const stdout = err.stdout?.toString().trim() || '';
    const output = stdout || stderr || err.message;
    if (output.includes('FAIL:')) {
      console.log(output);
    } else {
      console.log('FAIL:', test);
      if (stdout) console.log('  stdout:', stdout);
      if (stderr) console.log('  stderr:', stderr);
      if (!stdout && !stderr) console.log('  error:', err.message);
    }
    failed++;
    failures.push(test);
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  console.log('failures:', failures.join(', '));
  process.exit(1);
}
process.exit(0);
