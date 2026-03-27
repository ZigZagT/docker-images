// Run all tests sequentially. Each test is a separate process to isolate state.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tests = fs.readdirSync(dir)
  .filter(f => /^\d+-.*\.mjs$/.test(f))
  .sort();

let passed = 0;
let failed = 0;
const failures = [];

for (const test of tests) {
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
    console.log(output.includes('FAIL:') ? output : 'FAIL: ' + test + ' — ' + output.split('\n')[0]);
    failed++;
    failures.push(test);
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  console.log('failures:', failures.join(', '));
  process.exit(1);
}
