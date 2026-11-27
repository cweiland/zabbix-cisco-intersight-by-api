// Paging of the Intersight list endpoints (listAllObjects in src/collector.js).
// Cisco Intersight API Docs, "Query Language", "$top and $skip Query Options: Pagination":
// "You can specify $orderby to sort the results such that paginated results are returned in a
// predictable order"; the page states no default order. So every inventory and alarm page is
// sorted by Moid ($orderby=Moid, accepted on the user's appliance with $top, $skip, $filter and
// $select, CLAUDE.md, 2026-11-27). A list cut at MAX_ITEMS_PER_LIST objects is reported in
// api.errors and the objects read are kept.
// Fixture objects only (fictitious Moids and names).
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const collectorCode = fs.readFileSync(process.env.COLLECTOR_CODE_FILE ||
  path.join(__dirname, '..', 'src', 'collector.js'), 'utf8');
const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
global.sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
global.sign = () => { throw 'unused'; };
const toJson = JSON.stringify;
// Same values as PAGE_SIZE and MAX_ITEMS_PER_LIST in src/collector.js (checked below).
const PAGE_SIZE = 1000, MAX_ITEMS_PER_LIST = 20000;
const SERVERS_PATH = '/api/v1/compute/PhysicalSummaries';

let serverCount = 1;               // number of fixture servers behind compute/PhysicalSummaries
let alwaysFullServerPages = false; // every server page answers $top objects, however far $skip goes
let getRequests = [];              // URL of every GET of the current run
const verified = [];               // one entry per Intersight request: signature valid or not

global.HttpRequest = function () { this.headers = []; };
HttpRequest.prototype.clearHeader = function () { this.headers = []; };
HttpRequest.prototype.addHeader = function (header) { this.headers.push(header); };
HttpRequest.prototype.getStatus = function () { return 200; };
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
const queryOf = url => new URLSearchParams(url.split('?')[1] || '');
// Server <index>: Moids padded so that their text order is the index order (sorted by Moid).
const fixtureServer = index => ({ Moid: 'srv' + String(index).padStart(5, '0'), Name: 'fixture-server-' + index,
  Model: 'UCSC-C220-M6S', SourceObjectType: 'compute.RackUnit' });
HttpRequest.prototype.get = function (url) {
  this.verifySignature('get', url);
  getRequests.push(url);
  if (url.includes('PhysicalSummaries')) {
    // Answers the requested page ($top objects from $skip) of the fixture list.
    const query = queryOf(url), top = Number(query.get('$top')), skip = Number(query.get('$skip'));
    const end = alwaysFullServerPages ? skip + top : Math.min(serverCount, skip + top);
    const results = [];
    for (let index = skip; index < end; index++) results.push(fixtureServer(index));
    return toJson({ Results: results });
  }
  if (url.includes('Chasses')) return toJson({ Results: [{ Moid: 'cha1', Name: 'fixture-chassis', Model: 'UCSX-9508' }] });
  if (url.includes('ElementSummaries')) return toJson({ Results: [{ Moid: 'fi1', Name: 'fixture-fi', Model: 'UCS-FI-6454' }] });
  if (url.includes('cond/Alarms')) return toJson({ Results: [{ Moid: 'alarm1', Name: 'FixtureAlarm', Code: 'F0001',
    Severity: 'Warning', Acknowledge: 'None', Suppressed: false, AncestorMoId: 'cha1', AncestorMoType: 'equipment.Chassis' }] });
  return toJson({ Results: [] });
};
HttpRequest.prototype.post = function (url, body) {
  this.verifySignature('post', url);
  return '[]';
};

const collector = new Function('value', collectorCode);
const runCollector = () => {
  getRequests = [];
  return JSON.parse(collector(toJson({ key_id: 'K', api_host: 'intersight.com',
    private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }) })));
};
const check = (label, condition) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + label);
  if (!condition) process.exitCode = 1;
};
const serverRequests = () => getRequests.filter(url => url.includes('PhysicalSummaries'));
const skipValues = requests => requests.map(url => queryOf(url).get('$skip')).join(',');
const sortedByMoid = url => queryOf(url).get('$orderby') === 'Moid';
const distinctMoids = list => new Set(list.map(device => device.moid)).size;

check('test constants match src/collector.js (PAGE_SIZE 1000, MAX_ITEMS_PER_LIST 20000)',
  collectorCode.includes('var PAGE_SIZE = 1000;') && collectorCode.includes('var MAX_ITEMS_PER_LIST = 20000;'));

// --- One page per list
serverCount = 1;
const smallOutput = runCollector();
const listPaths = ['compute/PhysicalSummaries', 'equipment/Chasses', 'network/ElementSummaries', 'cond/Alarms'];
const listRequests = getRequests.filter(url => listPaths.some(listPath => url.includes(listPath)));
check('one request per inventory list and for the alarms',
  listPaths.every(listPath => listRequests.filter(url => url.includes(listPath)).length === 1));
check('every inventory and alarm request has $orderby=Moid', listRequests.length === 4 && listRequests.every(sortedByMoid));
const alarmQuery = queryOf(listRequests.find(url => url.includes('cond/Alarms')));
check('alarm request keeps $top, $skip, $filter and $select next to $orderby',
  alarmQuery.get('$top') === '1000' && alarmQuery.get('$skip') === '0' &&
  alarmQuery.get('$filter').startsWith("Severity ne 'Cleared'") && alarmQuery.get('$select').startsWith('Moid,'));
check('server list read without $select (SourceObjectType comes with every field)',
  !queryOf(serverRequests()[0]).has('$select'));
check('one page: no error', smallOutput.api.errors.length === 0);

// --- More than PAGE_SIZE objects: second page, last page not full
serverCount = 1500;
const twoPageOutput = runCollector();
check('1500 servers: two pages, $skip=0 then $skip=1000', skipValues(serverRequests()) === '0,1000');
check('1500 servers: both pages have $top=1000 and $orderby=Moid',
  serverRequests().every(url => queryOf(url).get('$top') === '1000' && sortedByMoid(url)));
check('1500 servers: every server read once',
  twoPageOutput.counts.servers === 1500 && twoPageOutput.servers.length === 1500 && distinctMoids(twoPageOutput.servers) === 1500);
check('1500 servers (last page not full): no truncation error', twoPageOutput.api.errors.length === 0);

// --- Exactly PAGE_SIZE objects: the second page is empty, not full
serverCount = 1000;
const fullFirstPageOutput = runCollector();
check('1000 servers: second request ($skip=1000) answers no object', skipValues(serverRequests()) === '0,1000');
check('1000 servers (last page empty): every server read, no truncation error',
  fullFirstPageOutput.counts.servers === 1000 && fullFirstPageOutput.api.errors.length === 0);

// --- Pages always full: reading stops at MAX_ITEMS_PER_LIST
alwaysFullServerPages = true;
const truncatedOutput = runCollector();
check('always full pages: reading stops after 20 pages ($skip 0 to 19000)',
  serverRequests().length === MAX_ITEMS_PER_LIST / PAGE_SIZE && queryOf(serverRequests()[19]).get('$skip') === '19000');
check('always full pages: every page has $orderby=Moid', serverRequests().every(sortedByMoid));
check('always full pages: truncation reported in api.errors (path and limit only)',
  toJson(truncatedOutput.api.errors) === toJson([SERVERS_PATH + ': list truncated at 20000 objects']));
check('always full pages: the 20000 servers read are kept (list and count)',
  truncatedOutput.counts.servers === 20000 && truncatedOutput.servers.length === 20000 &&
  distinctMoids(truncatedOutput.servers) === 20000);
check('always full pages: chassis and FI lists unaffected',
  truncatedOutput.chassis.length === 1 && truncatedOutput.fis.length === 1);

check('signatures verified ' + verified.filter(Boolean).length + '/' + verified.length,
  verified.length > 0 && verified.every(Boolean));
