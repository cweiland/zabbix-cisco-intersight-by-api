// Documents published in English and in French (maintainer decision, 2026-11-27): each pair
// exists, and each file links to the other language in its first lines (language line).
// Plain text search only: no RegExp built from a string (CodeQL "Incomplete string escaping").
// Usage: node tests/bilingual_docs.test.js   (no dependency, any platform)
const fs = require('fs'), path = require('path');

const repoRoot = path.join(__dirname, '..');
let failures = 0;
function check(name, condition, details) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (condition || !details ? '' : '\n     ' + details));
  if (!condition) { failures++; }
}

// [English file, French file], paths from the repository root. The French guides of docs/ keep
// their _FR names (maintainer decision, 2026-11-27).
const documentPairs = [
  ['README.md', 'README-fr.md'],
  ['CONTRIBUTING.md', 'CONTRIBUTING-fr.md'],
  ['docs/UPGRADE_7.4.md', 'docs/UPGRADE_7.4_FR.md'],
  ['docs/DEVCONTAINER_SECURITY.md', 'docs/DEVCONTAINER_SECURITE_FR.md'],
];
// The language line is at the top of each file, so the link is searched in the first lines only.
const LANGUAGE_LINE_SEARCH_LINES = 5;

function firstLinesOf(relative) {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf8').split('\n')
    .slice(0, LANGUAGE_LINE_SEARCH_LINES).join('\n');
}
// A Markdown link is relative to the folder of the file that contains it.
function markdownLinkTo(fromRelative, toRelative) {
  return '](' + path.posix.relative(path.posix.dirname(fromRelative), toRelative) + ')';
}

documentPairs.forEach(function (pair) {
  const englishFile = pair[0], frenchFile = pair[1];
  const bothExist = fs.existsSync(path.join(repoRoot, englishFile)) && fs.existsSync(path.join(repoRoot, frenchFile));
  check(englishFile + ' and ' + frenchFile + ' both exist', bothExist);
  if (!bothExist) { return; }
  [[englishFile, frenchFile], [frenchFile, englishFile]].forEach(function (direction) {
    const fromFile = direction[0], toFile = direction[1];
    const expectedLink = markdownLinkTo(fromFile, toFile);
    check(fromFile + ': links to ' + toFile + ' in its first ' + LANGUAGE_LINE_SEARCH_LINES + ' lines',
      firstLinesOf(fromFile).indexOf(expectedLink) !== -1, 'expected "' + expectedLink + '"');
  });
});

if (failures) { console.log(failures + ' failure(s)'); }
process.exitCode = failures ? 1 : 0;
