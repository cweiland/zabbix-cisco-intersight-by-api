// Size of the largest value pushed to intersight.raw (api.max_push_bytes / api.max_push_moid).
// intersight.raw is a stored Text item. Zabbix 7.0 manual, "Creating an item", "Text data limits":
// a Text value is truncated before being stored, to 65536 bytes on MySQL and 65536 characters on
// PostgreSQL; a MySQL TEXT column holds 65,535 bytes (MySQL 8.0 "String Data Type Syntax").
// The collector measures each pushed JSON in UTF-8 bytes; the parent template warns above
// {$INTERSIGHT.RAW.SIZE.WARN}. Fixture devices only (fictitious Moids and names).
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
global.sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
global.sign = () => { throw 'unused'; };
const toJson = JSON.stringify;
const check = (label, condition) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + label);
  if (!condition) process.exitCode = 1;
};

// Built from code points, so that this file stays plain ASCII.
const E_ACUTE = String.fromCodePoint(0xE9);      // 2 bytes in UTF-8, 1 UTF-16 unit
const EURO = String.fromCodePoint(0x20AC);       // 3 bytes, 1 unit
const GRINNING = String.fromCodePoint(0x1F600);  // 4 bytes, 2 units (surrogate pair)

let fabricInterconnects = [];
let pushedValues = [];
let pushRequestFails = false;
const verified = [];   // one entry per Intersight request: signature valid or not

global.HttpRequest = function () { this.headers = []; };
HttpRequest.prototype.clearHeader = function () { this.headers = []; };
HttpRequest.prototype.addHeader = function (header) { this.headers.push(header); };
HttpRequest.prototype.getStatus = function () { return this.status; };
// Checks the hs2019 signature of one request against the test key (as in tests/alarms.test.js).
HttpRequest.prototype.verifySignature = function (method, url) {
  const byName = {};
  this.headers.forEach(header => {
    const separator = header.indexOf(': ');
    byName[header.slice(0, separator).toLowerCase()] = header.slice(separator + 2);
  });
  const signingString = `(request-target): ${method} ${url.replace('https://intersight.com', '')}\n` +
    `host: ${byName.host}\ndate: ${byName.date}\ndigest: ${byName.digest}`;
  const signature = /signature="([^"]+)"/.exec(byName.authorization || '');
  verified.push(!!signature && crypto.verify('sha256', Buffer.from(signingString), ecKey.publicKey,
    Buffer.from(signature[1], 'base64')));
};
HttpRequest.prototype.get = function (url) {
  this.status = 200;
  this.verifySignature('get', url);
  if (url.includes('ElementSummaries')) return toJson({ Results: fabricInterconnects });
  return toJson({ Results: [] });
};
HttpRequest.prototype.post = function (url, body) {
  this.status = 200;
  if (url.includes('api_jsonrpc')) {
    pushedValues = JSON.parse(body).params;
    if (pushRequestFails) return toJson({ error: { message: 'fixture error', data: 'push refused' } });
    return toJson({ result: { data: pushedValues.map(() => ({ itemid: '1' })) } });
  }
  this.verifySignature('post', url);
  return '[]';
};

const code = fs.readFileSync(process.env.COLLECTOR_CODE_FILE || path.join(__dirname, '..', 'src', 'collector.js'), 'utf8');
const collector = new Function('value', code);
const runCollector = withPush => {
  pushedValues = [];
  const parameters = { key_id: 'K', api_host: 'intersight.com',
    private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }) };
  if (withPush) {
    parameters.zbx_url = 'https://zabbix.example.com/api_jsonrpc.php';
    parameters.zbx_token = 'fixture-token';
  }
  return JSON.parse(collector(toJson(parameters)));
};

// --- Byte count of one value: accents (2 bytes), euro sign (3 bytes), a 4-byte character.
// fi1 is the longest in UTF-16 units (40 ASCII characters), fi2 the largest in bytes
// (16 four-byte characters = 32 units, 64 bytes): a character count would pick fi1.
fabricInterconnects = [
  { Moid: 'fi1', Name: 'fixture-fi-' + 'x'.repeat(40), Model: 'UCS-FI-6454' },
  { Moid: 'fi2', Name: 'fixture-fi-' + GRINNING.repeat(16), Model: 'UCS-FI-6454' },
  { Moid: 'fi3', Name: 'fixture-fi-' + E_ACUTE + EURO + GRINNING, Model: 'UCS-FI-6454' },
];
let output = runCollector(true);
const bytesByMoid = {}, unitsByMoid = {};
pushedValues.forEach(entry => {
  const moid = entry.host.replace('intersight-', '');
  bytesByMoid[moid] = Buffer.byteLength(entry.value, 'utf8');
  unitsByMoid[moid] = entry.value.length;
});
check('three values pushed', pushedValues.length === 3);
check('fixture: fi3 holds 2-, 3- and 4-byte characters (bytes differ from UTF-16 units)',
  pushedValues.some(entry => entry.value.includes(E_ACUTE + EURO + GRINNING)) && bytesByMoid.fi3 !== unitsByMoid.fi3);
check('fixture: fi1 is the longest in UTF-16 units, fi2 the largest in bytes',
  unitsByMoid.fi1 > unitsByMoid.fi2 && bytesByMoid.fi2 > bytesByMoid.fi1);
check(`max_push_bytes is the exact UTF-8 size of the largest value (${output.api.max_push_bytes} = ${bytesByMoid.fi2})`,
  output.api.max_push_bytes === bytesByMoid.fi2 && output.api.max_push_bytes === Math.max(...Object.values(bytesByMoid)));
check(`max_push_moid names the device of the largest value (${output.api.max_push_moid})`, output.api.max_push_moid === 'fi2');

// One device: max_push_bytes is that value's exact size, with accents and a 4-byte character.
fabricInterconnects = [{ Moid: 'fi3', Name: 'fixture-fi-' + E_ACUTE + EURO + GRINNING, Model: 'UCS-FI-6454' }];
output = runCollector(true);
const singleValue = pushedValues[0].value;
check(`accents and a 4-byte character: ${output.api.max_push_bytes} bytes = Buffer.byteLength, not ${singleValue.length} units`,
  output.api.max_push_bytes === Buffer.byteLength(singleValue, 'utf8') && output.api.max_push_bytes > singleValue.length &&
  output.api.max_push_moid === 'fi3');

// --- utf8ByteLength() alone, including the Duktape form of a character above U+FFFF:
// Duktape 2.7.0 (bundled with Zabbix 7.0) keeps it as one character whose charCodeAt() is the
// full code point, which Node cannot produce; a stand-in object gives that charCodeAt().
const functionStart = code.indexOf('function utf8ByteLength(');
const functionEnd = code.indexOf('\n}\n', functionStart) + 2;
const utf8ByteLength = new Function(code.slice(functionStart, functionEnd) + '\nreturn utf8ByteLength;')();
const duktapeStyle = codePoints => ({ length: codePoints.length, charCodeAt: index => codePoints[index] });
const samples = ['', 'ascii', E_ACUTE, EURO, GRINNING, 'Salle ' + E_ACUTE + EURO + GRINNING + ' fin', toJson({ n: GRINNING + E_ACUTE })];
check('utf8ByteLength equals Buffer.byteLength on ASCII, 2-, 3- and 4-byte characters',
  functionStart >= 0 && samples.every(sample => utf8ByteLength(sample) === Buffer.byteLength(sample, 'utf8')));
check('utf8ByteLength: one Duktape character above U+FFFF = 4 bytes (0x1F600, then "a" + 0x10FFFF + 0xE9 = 7)',
  utf8ByteLength(duktapeStyle([0x1F600])) === 4 && utf8ByteLength(duktapeStyle([0x61, 0x10FFFF, 0xE9])) === 7);
check('utf8ByteLength: a lone surrogate counts 3 bytes',
  utf8ByteLength(String.fromCharCode(0xD83D)) === 3 && utf8ByteLength(String.fromCharCode(0xD83D) + 'a') === 4 &&
  utf8ByteLength(String.fromCharCode(0xDE00)) === 3);

// --- Measured even when history.push fails (the size does not depend on the answer)
pushRequestFails = true;
fabricInterconnects = [{ Moid: 'fi1', Name: 'fixture-fi', Model: 'UCS-FI-6454' }];
output = runCollector(true);
check('push request failed: size still reported, push.failed = 1',
  output.api.max_push_bytes === Buffer.byteLength(pushedValues[0].value, 'utf8') && output.api.max_push_moid === 'fi1' &&
  output.push.failed === 1);
pushRequestFails = false;

// --- Absent when nothing is pushed
output = runCollector(false);
check('push disabled: max_push_bytes and max_push_moid absent, nothing pushed',
  !('max_push_bytes' in output.api) && !('max_push_moid' in output.api) && output.push.enabled === 0 && pushedValues.length === 0);
fabricInterconnects = [];
output = runCollector(true);
check('no device: max_push_bytes and max_push_moid absent',
  !('max_push_bytes' in output.api) && !('max_push_moid' in output.api) && output.push.enabled === 1 && pushedValues.length === 0);

check(`every Intersight request signature verifies (${verified.length} requests)`, verified.length > 0 && verified.every(Boolean));

// --- Parent template: items, trigger and macro
const yaml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'zbx_intersight_templates_7.0.yaml'), 'utf8');
const between = (startText, endText) => {
  const start = yaml.indexOf(startText);
  const end = yaml.indexOf(endText, start + startText.length);
  return start < 0 || end < 0 ? '' : yaml.slice(start, end);
};
const sizeItem = between("name: 'API: largest pushed value'", "name: 'API: device of the largest pushed value'");
const moidItem = between("name: 'API: device of the largest pushed value'", "name: 'Push: values accepted'");
check('item intersight.api.push.max.bytes: dependent on intersight.collect, UNSIGNED, unit B, $.api.max_push_bytes, DISCARD_VALUE',
  sizeItem.includes('type: DEPENDENT') && sizeItem.includes('key: intersight.api.push.max.bytes\n') &&
  sizeItem.includes('value_type: UNSIGNED') && sizeItem.includes('key: intersight.collect') &&
  sizeItem.includes('units: B\n') && sizeItem.includes('- $.api.max_push_bytes\n') &&
  sizeItem.includes('error_handler: DISCARD_VALUE'));
check('trigger WARNING: last(...max.bytes) > {$INTERSIGHT.RAW.SIZE.WARN}, description cites the MySQL limit and its source',
  sizeItem.includes('expression: last(/Cisco Intersight by API/intersight.api.push.max.bytes)>{$INTERSIGHT.RAW.SIZE.WARN}\n') &&
  sizeItem.includes('priority: WARNING') && sizeItem.includes('65,535 bytes') &&
  sizeItem.includes('MySQL 8.0 manual, "String Data Type Syntax"') && sizeItem.includes('"Text data limits"'));
check('item intersight.api.push.max.moid: dependent, CHAR, $.api.max_push_moid, DISCARD_VALUE',
  moidItem.includes('type: DEPENDENT') && moidItem.includes('key: intersight.api.push.max.moid\n') &&
  moidItem.includes('value_type: CHAR') && moidItem.includes('- $.api.max_push_moid\n') &&
  moidItem.includes('error_handler: DISCARD_VALUE'));
const macroBlock = between("macro: '{$INTERSIGHT.RAW.SIZE.WARN}'", '- macro:');
check('macro {$INTERSIGHT.RAW.SIZE.WARN} = 50000, below the 65,535-byte MySQL limit, description cites it',
  macroBlock.includes("value: '50000'") && macroBlock.includes('65,535 bytes') && macroBlock.includes('MySQL'));
