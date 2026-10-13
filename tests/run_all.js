// Runs every *.test.js file in this folder. Exit code 1 if any test fails.
// Usage: node tests/run_all.js   (Node.js 16+, no dependency)
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
let failed = 0;
for (const file of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()) {
  console.log('\n=== ' + file);
  try {
    process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', timeout: 240000 }));
  } catch (e) {
    process.stdout.write(e.stdout || '');
    console.log('>>> FAILED: ' + file);
    failed++;
  }
}
console.log(failed ? `\n${failed} test file(s) failed` : '\nAll test files passed');
process.exitCode = failed ? 1 : 0;
