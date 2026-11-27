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
  check('Dependabot watches ' + ecosystem, dependabot.indexOf('package-ecosystem: "' + ecosystem + '"') !== -1);
});
check('security policy (SECURITY.md) points to private vulnerability reporting',
  /Report a vulnerability/.test(read('SECURITY.md')));
check('.gitignore keeps .env and .env.* out', /^\.env$/m.test(read('.gitignore')) && /^\.env\.\*$/m.test(read('.gitignore')));

// AGPL-3.0-only: the FSF text, unchanged (sha256 of https://www.gnu.org/licenses/agpl-3.0.txt).
const licenseHash = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'LICENSE'))).digest('hex');
check('LICENSE is the unchanged AGPL-3.0 text from gnu.org',
  licenseHash === '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0', licenseHash);
check('README states AGPL-3.0-only', /AGPL-3\.0-only/.test(read('README.md')));

// The assistants' instruction files carry the essential rules themselves (VS Code does not
// guarantee that a file linked from an instructions file reaches every request).
const copilotInstructions = read('.github/copilot-instructions.md');
['no inference', 'personal data', 'ES5', 'never edit it by hand', 'docs/intersight_metrics.json',
 'tools/ci.sh', 'Git is read-only', 'params.json', 'check-host-credentials.sh'].forEach(function (rule) {
  check('copilot-instructions.md states: ' + rule, copilotInstructions.indexOf(rule) !== -1);
});
check('CLAUDE.md has the working rules (no inference, security and personal data check)',
  /## Working rules/.test(read('CLAUDE.md')) && /no inference/.test(read('CLAUDE.md')) && /personal data/.test(read('CLAUDE.md')));

// The commit message file must be named in each place: a rename in only one of them would
// break the workflow without failing the check (Copilot review of PR #8).
const changeWorkflowSection = (read('CLAUDE.md').split('## Change workflow')[1] || '').split('\n## ')[0];
check('change workflow: .commit-msg.txt is git-ignored', /^\.commit-msg\.txt$/m.test(read('.gitignore')));
check('change workflow: CLAUDE.md section names .commit-msg.txt (message file and commit -F)',
  changeWorkflowSection.indexOf('`.commit-msg.txt`') !== -1 &&
  changeWorkflowSection.indexOf('git commit -F .commit-msg.txt') !== -1);
check('change workflow: copilot-instructions.md names .commit-msg.txt',
  read('.github/copilot-instructions.md').indexOf('.commit-msg.txt') !== -1);

// Shared rules of the two instruction files. Whitespace is collapsed first, so that a line
// break inside a sentence of copilot-instructions.md (wrapped text) does not hide it.
function collapseWhitespace(text) { return text.replace(/\s+/g, ' '); }
function markdownSection(text, heading) { return (text.split('## ' + heading)[1] || '').split('\n## ')[0]; }
const claudeInstructions = read('CLAUDE.md');
const instructionFiles = { 'CLAUDE.md': claudeInstructions, '.github/copilot-instructions.md': copilotInstructions };

check('change workflow: CLAUDE.md says to check `git diff` before retrying a failed edit',
  collapseWhitespace(changeWorkflowSection).indexOf('`git diff` before retrying') !== -1);
check('change workflow: copilot-instructions.md says to check `git diff` before retrying a failed edit',
  collapseWhitespace(copilotInstructions).indexOf('`git diff` before retrying') !== -1);

// Change workflow rules that were only in CLAUDE.md (review of PR #14): both files state them.
['check that the working tree is clean', 'One change at a time',
 'for security problems and personal data like any change', 'a writable `.git`'].forEach(function (rule) {
  Object.keys(instructionFiles).forEach(function (file) {
    var text = collapseWhitespace(instructionFiles[file]);
    check('change workflow: ' + file + ' states: ' + rule,
      text.toLowerCase().indexOf(rule.toLowerCase()) !== -1);
  });
});
// Unit rules (PR #13 and #14), so that Copilot reviews apply them too.
['Base units only', 'requires a new item key', 'Zabbix_Documentation'].forEach(function (rule) {
  Object.keys(instructionFiles).forEach(function (file) {
    check('units and docs: ' + file + ' states: ' + rule,
      collapseWhitespace(instructionFiles[file]).indexOf(rule) !== -1);
  });
});

// Test rule (CodeQL "Incomplete string escaping", PR #17 and #19): Copilot writes tests too.
Object.keys(instructionFiles).forEach(function (file) {
  check('testing: ' + file + ' states: Never build a RegExp from a string in tests',
    collapseWhitespace(instructionFiles[file]).indexOf('Never build a RegExp from a string in tests') !== -1);
});

// The sync rule is the "Working rules" bullet that contains "in the same change"; each file's
// rule must name the other file, otherwise a change in one would not lead to the other.
function syncRule(text) {
  const bullets = markdownSection(text, 'Working rules').split('\n- ');
  return collapseWhitespace(bullets.filter(function (bullet) { return bullet.indexOf('in the same change') !== -1; })[0] || '');
}
check('sync rule of CLAUDE.md names .github/copilot-instructions.md',
  syncRule(claudeInstructions).indexOf('`.github/copilot-instructions.md`') !== -1, syncRule(claudeInstructions));
check('sync rule of copilot-instructions.md names CLAUDE.md',
  syncRule(copilotInstructions).indexOf('`CLAUDE.md`') !== -1, syncRule(copilotInstructions));

Object.keys(instructionFiles).forEach(function (file) {
  const workingRules = collapseWhitespace(markdownSection(instructionFiles[file], 'Working rules'));
  ['agent-facing file', 'compare the shared rules', 'head branch'].forEach(function (phrase) {
    check(file + ' "Working rules" states: ' + phrase, workingRules.indexOf(phrase) !== -1);
  });
});

// No agent-facing file beyond those the two instruction files describe. A new one must be
// added to both files (definition of agent-facing files) and to this test.
// Fixed paths: Copilot instruction and prompt folders, project MCP servers.
const unexpectedAgentPaths = ['.github/instructions', '.github/prompts', '.mcp.json'].filter(function (relative) {
  return fs.existsSync(path.join(repoRoot, relative));
});
// .claude/ is an allowlist: agents, commands, skills, rules, output-styles, CLAUDE.md or any
// other entry is a new agent-facing file (Copilot review of PR #12).
const allowedClaudeEntries = ['settings.json', 'settings.local.json'];
const unexpectedClaudeEntries = (fs.existsSync(path.join(repoRoot, '.claude')) ? fs.readdirSync(path.join(repoRoot, '.claude')) : [])
  .filter(function (name) { return allowedClaudeEntries.indexOf(name) === -1; })
  .map(function (name) { return '.claude/' + name; });
// Instruction file names searched in the whole repository, not only at the root (Copilot
// review of PR #12); only the root CLAUDE.md is expected.
const agentInstructionFileNames = ['AGENTS.md', 'GEMINI.md', 'CLAUDE.local.md', 'CLAUDE.md'];
function findAgentInstructionFiles(relativeDir) {
  let found = [];
  fs.readdirSync(path.join(repoRoot, relativeDir), { withFileTypes: true }).forEach(function (entry) {
    const relative = relativeDir ? relativeDir + '/' + entry.name : entry.name;
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
      found = found.concat(findAgentInstructionFiles(relative));
    } else if (agentInstructionFileNames.indexOf(entry.name) !== -1 && relative !== 'CLAUDE.md') {
      found.push(relative);
    }
  });
  return found;
}
const unexpectedAgentFiles = unexpectedAgentPaths.concat(unexpectedClaudeEntries, findAgentInstructionFiles(''));
check('no agent-facing file beyond the root CLAUDE.md, .claude/settings.json, .claude/settings.local.json and .github/copilot-instructions.md',
  unexpectedAgentFiles.length === 0,
  'found ' + unexpectedAgentFiles.join(', ') + ': update both instruction files (CLAUDE.md and ' +
  '.github/copilot-instructions.md, agent-facing files) and this test');

// Claude Code imports "@path" files from CLAUDE.md (outside code spans and code blocks);
// an import would load a file that the review rules do not cover.
function textOutsideCode(text) { return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, ''); }
Object.keys(instructionFiles).forEach(function (file) {
  const imports = textOutsideCode(instructionFiles[file]).match(/(^|\s)@[\w.~\/-]+/g) || [];
  check(file + ': no @path import outside code', imports.length === 0, imports.join(' '));
});

if (failures) { console.log(failures + ' failure(s)'); }
process.exitCode = failures ? 1 : 0;
