// Checks of the repository configuration that keeps the CI and the supply chain fixed:
// GitHub Actions pinned by full commit SHA, read-only workflow token, no persisted checkout
// credentials, Dependabot configured for every pinned ecosystem, security policy present.
// Usage: node tests/repository_config.test.js   (no dependency, any platform)
const fs = require('fs'), path = require('path');

const repoRoot = path.join(__dirname, '..');
let failures = 0;
function check(name, condition, details) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (condition || !details ? '' : '\n     ' + details));
  if (!condition) { failures++; }
}
function read(relative) { return fs.readFileSync(path.join(repoRoot, relative), 'utf8'); }

const workflowDir = path.join(repoRoot, '.github/workflows');
fs.readdirSync(workflowDir).filter(function (f) { return /\.ya?ml$/.test(f); }).forEach(function (file) {
  const workflow = read('.github/workflows/' + file);
  const uses = workflow.match(/^\s*-?\s*uses:\s*\S+/gm) || [];
  const unpinned = uses.filter(function (line) { return !/@[0-9a-f]{40}(\s|$)/.test(line); });
  check(file + ': every action pinned by a full commit SHA', unpinned.length === 0, unpinned.join(' | '));
  check(file + ': read-only token (permissions: contents: read)', /^permissions:\s*\n\s+contents:\s*read\s*$/m.test(workflow));
  check(file + ': runner pinned to ubuntu-24.04 (the dev container release), not ubuntu-latest',
    /runs-on:\s*ubuntu-24\.04\s*$/m.test(workflow) && !/runs-on:\s*ubuntu-latest/.test(workflow));
  check(file + ': checkout does not persist credentials',
    !/actions\/checkout@/.test(workflow) || /persist-credentials:\s*false/.test(workflow));
});

const dependabot = read('.github/dependabot.yml');
['github-actions', 'devcontainers', 'docker', 'pip'].forEach(function (ecosystem) {
  check('Dependabot watches ' + ecosystem, new RegExp('package-ecosystem:\\s*"' + ecosystem + '"').test(dependabot));
});
check('security policy (SECURITY.md) points to private vulnerability reporting',
  /Report a vulnerability/.test(read('SECURITY.md')));
check('.gitignore keeps .env and .env.* out', /^\.env$/m.test(read('.gitignore')) && /^\.env\.\*$/m.test(read('.gitignore')));

// AGPL-3.0-only: the FSF text, unchanged (sha256 of https://www.gnu.org/licenses/agpl-3.0.txt).
const licenseHash = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'LICENSE'))).digest('hex');
check('LICENSE is the unchanged AGPL-3.0 text from gnu.org',
  licenseHash === '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0', licenseHash);
check('README states AGPL-3.0-only', /AGPL-3\.0-only/.test(read('README.md')));

if (failures) { console.log(failures + ' failure(s)'); }
process.exitCode = failures ? 1 : 0;
