/*
 * =====================================================================================
 *  Cisco Intersight collector for Zabbix 7.0+ (Script item "intersight.collect")
 * =====================================================================================
 *
 *  WHAT IT DOES (one run, every 5 minutes)
 *    1. Reads the inventory from the Intersight REST API:
 *         servers (rack + blade), chassis, Fabric Interconnects, unacknowledged alarms.
 *    2. Reads telemetry (Apache Druid "groupBy" queries), grouped by device type and name:
 *         power, temperatures, fans, power supplies, memory, CPU, network.
 *    3. Builds one JSON object per device and pushes it, through the Zabbix API method
 *       history.push, to the trapper item "intersight.raw" of the discovered host
 *       "intersight-<Moid>".
 *    4. Returns a JSON document used by the parent host: LLD rules, health items.
 *
 *  JAVASCRIPT ENGINE CONSTRAINTS (Duktape, embedded in Zabbix)
 *    - ECMAScript 5.1 only: no let/const, no arrow functions, no template strings.
 *    - Zabbix helpers used: HttpRequest, sha256(), sign() (RSA only).
 *    - No elliptic-curve crypto is available, so ECDSA P-256 (API keys v3, "hs2019")
 *      is implemented in pure JavaScript in the section "ECDSA P-256".
 *
 *  ITEM PARAMETERS (received as JSON in the variable "value")
 *    auth           hs2019 (API key v3, EC) | rsa (API key v2) | oauth (client credentials)
 *    key_id         API key ID (hs2019 / rsa)
 *    private_key    private key: full PEM, PEM with literal "\n", or base64 body on one line
 *    client_id      OAuth2 client ID (oauth)
 *    client_secret  OAuth2 client secret (oauth)
 *    api_host       Intersight FQDN, e.g. intersight.com
 *    window         telemetry window in minutes
 *    datasource     Druid dataSource of hardware metrics (Cisco doc: PhysicalEntities)
 *    network_datasource  Druid dataSource of network metrics (Cisco doc: NetworkInterfaces)
 *    component_dim  Druid attribute naming one PSU / sensor / port (Cisco doc: name)
 *    flat_servers   1 = all servers in the "servers" LLD, 0 = rack servers only (7.4 nested)
 *    percent_scale  multiplier turning the raw utilizations into % (default 100: Intersight
 *                   stores them as 0-1 ratios, checked in the raw data of the user's
 *                   appliance, although Cisco's doc gives the unit "%")
 *    zbx_url        Zabbix API URL, used by history.push
 *    zbx_token      Zabbix API token, used by history.push
 *
 *  JSON CONTRACT WITH THE TEMPLATES (do not rename these fields without updating the YAML)
 *    Device object (pushed to intersight.raw, and listed in servers / chassis / fis):
 *      moid, name, display, class, model, serial, alarm_critical, alarm_warning,
 *      power_w, power_max_w, power_source, power_state,
 *      temp_max, temp_margin_min, temp_margin_degraded_min,
 *      fan_min, fan_max, fan_margin_min, psu_util_max,
 *      cpu_util, cpu_util_max, mem_util, mem_ecc_correctable, mem_ecc_uncorrectable, mem_ecc_dimms,
 *      net_errors, firmware, mgmt_ip, oper_state, chassis_key, is_blade,
 *      psus  [ {name, util, out_w, in_w} ],
 *      ports [ {name, role, rx_bps, tx_bps, speed_bps, util, up, errors} ]  (bits per second),
 *      blades [ {moid, display, model} ]   (chassis only)
 *    Returned document:
 *      ts, api {calls, errors[], duration_ms, sign_ms}, counts {servers, chassis, fi},
 *      alarms {critical, warning, info}, push {enabled, sent, failed},
 *      servers[], chassis[], fis[], models [ {class, model, group} ]
 *
 *  METRIC SOURCES (rule: no inferred field name)
 *    Every Druid field queried below appears in an "Available metrics" table of the Cisco
 *    Intersight "Supported Metrics" pages (intersight.com/apidocs/introduction/<instrument>).
 *    docs/intersight_metrics.json is the catalog extracted from those pages
 *    (tools/build_metrics_catalog.py); tests/documented_fields.test.js fails if the
 *    collector queries a field or uses a dataSource that is not in the catalog.
 *    The "Support information" of each metric tells which devices report it, e.g.:
 *      - hw.host.power ........................ blades, racks, FI (NOT IMM chassis)
 *      - hw.power (PSU input power) ........... chassis, FI, racks -> IMM chassis power
 *      - hw.cpu, hw.temperature.limit_high_degraded ... imm-blade-mqtt, imm-ism-rack-mqtt
 *      - hw.fan.speed.limit_low_critical ...... imm-chassis-mqtt-*, imm-ism-rack-mqtt
 *    Devices outside a metric's support list return no row: the item stays empty.
 *    Intersight Virtual Appliance: metrics need a metrics node (multi-node deployment)
 *    or the opt-in collection of a single-node deployment.
 *
 *  WHERE TO CHANGE THINGS
 *    - API endpoints ...................... INTERSIGHT_PATHS
 *    - Telemetry metrics / field names .... TELEMETRY_QUERIES
 *    - Fields read from the inventory ..... buildServerDevice / buildChassisDevice / buildFabricInterconnectDevice
 *    - Host naming of discovered devices .. ZABBIX_HOST_PREFIX (must match the host prototypes)
 * =====================================================================================
 */

// =====================================================================================
//  1. CONFIGURATION
// =====================================================================================

var itemParameters = JSON.parse(value);

var CONFIG = {
    authMode: String(itemParameters.auth || 'hs2019').toLowerCase(),
    apiHost: itemParameters.api_host || 'intersight.com',
    // Collection interval (Intersight help "Data Collection"): 1 min with the Advantage
    // tier, 10 min with Essentials (and for UMM). Default 10 min = Advantage; use 30 with
    // Essentials so that each window keeps at least 2 samples.
    telemetryWindowMinutes: parseInt(itemParameters.window || '10', 10),
    // Druid dataSources, as documented per instrument by Cisco.
    druidPhysicalDataSource: itemParameters.datasource || 'PhysicalEntities',
    druidNetworkDataSource: itemParameters.network_datasource || 'NetworkInterfaces',
    druidComponentDimension: itemParameters.component_dim || 'name',
    // When false, blades are left out of the "servers" LLD: they are discovered under
    // their chassis instead (Zabbix 7.4 nested discovery). They are still pushed.
    discoverBladesAsServers: String(itemParameters.flat_servers) !== '0',
    // Utilizations are stored by Intersight as 0-1 ratios (raw data checked on the user's
    // appliance; the intersight-grafana dashboards also multiply them by 100), although
    // Cisco's doc gives the unit "%". checkPercentage() flags any value above 100 %.
    percentScale: parseFloat(itemParameters.percent_scale || '100'),
    // Push is enabled only when both URL and token are set (not left as raw macros).
    pushEnabled: !!(itemParameters.zbx_url && itemParameters.zbx_token &&
        itemParameters.zbx_url.indexOf('{$') !== 0)
};

var INTERSIGHT_PATHS = {
    servers: '/api/v1/compute/PhysicalSummaries',
    chassis: '/api/v1/equipment/Chasses',
    fabricInterconnects: '/api/v1/network/ElementSummaries',
    alarms: '/api/v1/cond/Alarms',
    // Cisco DevNet "Telemetry APIs - Query Syntax": queries (groupBy included) use TimeSeries.
    telemetryQuery: '/api/v1/telemetry/TimeSeries',
    oauthToken: '/iam/token'
};

// Only alarms still open and not acknowledged by an operator are counted.
var OPEN_ALARMS_FILTER = "Acknowledge eq 'None' and Severity ne 'Cleared'";

// Page size for list requests (Intersight maximum is 1000).
var PAGE_SIZE = 1000;
var MAX_ITEMS_PER_LIST = 20000;

// Discovered hosts are named "<prefix><Moid>". Must match the host prototypes.
var ZABBIX_HOST_PREFIX = 'intersight-';
var ZABBIX_RAW_ITEM_KEY = 'intersight.raw';

// Host group names used by the per-model aggregates (must match the group prototypes).
var HOST_GROUP_BY_CLASS = { server: 'Servers', chassis: 'Chassis', fi: 'FI' };

// Telemetry attribute "host.type" -> device class. Telemetry is matched to the
// inventory by (class, name): "host.name" alone is not unique (Cisco doc), and a
// chassis may share its name with a server.
var DEVICE_CLASS_BY_HOST_TYPE = {
    'compute.Blade': 'server',
    'compute.RackUnit': 'server',
    'equipment.Chassis': 'chassis',
    'network.Element': 'fi'
};
var UNKNOWN_DEVICE_CLASS = 'any';

// Attributes every telemetry query is grouped by (component attribute and per-query
// extraAttributes are added to these). All are listed in docs/intersight_metrics.json.
var GROUP_BY_ATTRIBUTES = ['host.name', 'host.type'];

// Run statistics, reported in the "api" section of the output.
var runStartTime = new Date().getTime();
var collectedErrors = [];
var apiCallCount = 0;
var signingTimeMs = 0;

// =====================================================================================
//  2. GENERIC HELPERS
// =====================================================================================

function padTwoDigits(number) {
    return (number < 10 ? '0' : '') + number;
}

// RFC 7231 date ("Mon, 12 Oct 2026 10:00:00 GMT"), required by the HTTP signature.
// Built by hand because Duktape's toUTCString() format is not guaranteed.
function formatHttpDate(date) {
    var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return dayNames[date.getUTCDay()] + ', ' + padTwoDigits(date.getUTCDate()) + ' ' +
        monthNames[date.getUTCMonth()] + ' ' + date.getUTCFullYear() + ' ' +
        padTwoDigits(date.getUTCHours()) + ':' + padTwoDigits(date.getUTCMinutes()) + ':' +
        padTwoDigits(date.getUTCSeconds()) + ' GMT';
}

var BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Byte array -> base64 string.
function bytesToBase64(bytes) {
    var output = '', index, triplet;
    for (index = 0; index < bytes.length; index += 3) {
        triplet = (bytes[index] << 16) | ((bytes[index + 1] || 0) << 8) | (bytes[index + 2] || 0);
        output += BASE64_ALPHABET.charAt((triplet >> 18) & 63) + BASE64_ALPHABET.charAt((triplet >> 12) & 63) +
            (index + 1 < bytes.length ? BASE64_ALPHABET.charAt((triplet >> 6) & 63) : '=') +
            (index + 2 < bytes.length ? BASE64_ALPHABET.charAt(triplet & 63) : '=');
    }
    return output;
}

// Hex string (as returned by Zabbix sha256() / sign()) -> base64 string.
// Pure JS on purpose: btoa() is not reliable with binary data in Duktape.
function hexToBase64(hexString) {
    var bytes = [], index;
    for (index = 0; index < hexString.length; index += 2) {
        bytes.push(parseInt(hexString.substr(index, 2), 16));
    }
    return bytesToBase64(bytes);
}

// Base64 string (whitespace and PEM noise ignored) -> byte array.
function base64ToBytes(base64String) {
    var bytes = [], buffer = 0, bufferedBits = 0, index;
    var cleaned = base64String.replace(/[^A-Za-z0-9+\/]/g, '');
    for (index = 0; index < cleaned.length; index++) {
        buffer = (buffer << 6) | BASE64_ALPHABET.indexOf(cleaned.charAt(index));
        bufferedBits += 6;
        if (bufferedBits >= 8) {
            bufferedBits -= 8;
            bytes.push((buffer >> bufferedBits) & 255);
        }
    }
    return bytes;
}

// Returns the value if it is a finite number, otherwise null.
function numberOrNull(candidate) {
    return (typeof candidate === 'number' && isFinite(candidate)) ? candidate : null;
}

// numerator / denominator, or null if either is missing or the denominator is 0.
function divideOrNull(numerator, denominator) {
    numerator = numberOrNull(numerator);
    denominator = numberOrNull(denominator);
    return (numerator !== null && denominator) ? numerator / denominator : null;
}

// Lowest of two values, ignoring nulls.
function minIgnoringNull(first, second) {
    if (first === null || first === undefined) { return second; }
    if (second === null || second === undefined) { return first; }
    return Math.min(first, second);
}

function roundToOneDecimal(number) {
    return number === null ? null : Math.round(number * 10) / 10;
}

// Highest of two values, ignoring nulls.
function maxIgnoringNull(first, second) {
    if (first === null || first === undefined) { return second; }
    if (second === null || second === undefined) { return first; }
    return Math.max(first, second);
}

// Sets object[key] only when the value is meaningful. Missing keys make the dependent
// items discard the value instead of storing a wrong 0 or failing on "null".
function setIfPresent(targetObject, key, candidate) {
    if (candidate !== null && candidate !== undefined && candidate !== '') {
        targetObject[key] = candidate;
    }
}

function objectValues(sourceObject) {
    var values = [], key;
    for (key in sourceObject) {
        if (sourceObject.hasOwnProperty(key)) { values.push(sourceObject[key]); }
    }
    return values;
}

// Sanity check of a percentage after scaling: above 100 % means the scale macro is wrong
// (e.g. a value already in percent multiplied by 100). Reported once per metric and run.
var reportedUnitProblems = {};
// Raw system.cpu idle values of the run, to detect a 0-1 ratio read as a percentage.
var rawIdleValues = [];
function checkPercentage(metricName, percentValue, scaleMacro) {
    if (percentValue !== null && percentValue > 100.5 && !reportedUnitProblems[metricName]) {
        reportedUnitProblems[metricName] = true;
        collectedErrors.push('units: ' + metricName + ' = ' + percentValue + ' % after scaling (above 100): ' +
            'check ' + scaleMacro + ' (1 if Intersight already returns a percentage, 100 if it returns 0-1)');
    }
    return percentValue;
}

// Runs a collection step. On failure, records the error and returns null, so that one
// failing endpoint or metric never stops the rest of the collection.
function runStepOrRecordError(stepName, stepFunction) {
    try {
        return stepFunction();
    }
    catch (error) {
        collectedErrors.push(stepName + ': ' + error);
        return null;
    }
}

// =====================================================================================
//  3. ECDSA P-256 / SHA-256 IN PURE JAVASCRIPT (for API keys v3, "hs2019")
// =====================================================================================
//  Why: Zabbix sign() only supports RSA. Intersight API keys v3 are EC keys on the
//  P-256 curve (prime256v1), signed with ECDSA + SHA-256, signature DER-encoded.
//
//  Standards implemented:
//    - FIPS 180-4  SHA-256          - RFC 2104  HMAC
//    - SEC 1 / FIPS 186-4  ECDSA    - RFC 6979  deterministic nonce ("k")
//  The deterministic nonce matters for security: a predictable random nonce in ECDSA
//  reveals the private key. Math.random() is therefore never used.
//
//  Numbers are 256-bit integers stored as 16 "limbs" of 16 bits, least significant
//  first. Multiplications modulo p (curve field) and n (curve order) use Montgomery
//  multiplication, which avoids costly divisions.
//
//  Validated against the RFC 6979 test vector A.2.5 and against OpenSSL verification.
// =====================================================================================
// ===== BEGIN EcdsaP256 =====
var EcdsaP256 = (function () {
    var LIMB_COUNT = 16;        // 16 limbs x 16 bits = 256 bits
    var LIMB_BASE = 65536;      // 2^16

    // ---------------------------------------------------------------- SHA-256 (bytes)
    var SHA256_ROUND_CONSTANTS = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

    function rotateRight32(word, bits) {
        return (word >>> bits) | (word << (32 - bits));
    }

    // SHA-256 of a byte array, returns a 32-byte array.
    // (Zabbix sha256() works on strings and returns hex; here we need raw bytes for HMAC.)
    function sha256Bytes(messageBytes) {
        var state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        var padded = messageBytes.slice(0), bitLength = messageBytes.length * 8;
        var schedule = [], blockStart, round, digest = [];
        var a, b, c, d, e, f, g, h, temp1, temp2, sigma0, sigma1;

        // Padding: 0x80, zeros, then the 64-bit message length (fits in 32 bits here).
        padded.push(0x80);
        while (padded.length % 64 !== 56) { padded.push(0); }
        padded.push(0, 0, 0, 0, (bitLength >>> 24) & 255, (bitLength >>> 16) & 255, (bitLength >>> 8) & 255, bitLength & 255);

        for (blockStart = 0; blockStart < padded.length; blockStart += 64) {
            for (round = 0; round < 16; round++) {
                schedule[round] = (padded[blockStart + 4 * round] << 24) | (padded[blockStart + 4 * round + 1] << 16) |
                    (padded[blockStart + 4 * round + 2] << 8) | padded[blockStart + 4 * round + 3];
            }
            for (round = 16; round < 64; round++) {
                sigma0 = rotateRight32(schedule[round - 15], 7) ^ rotateRight32(schedule[round - 15], 18) ^ (schedule[round - 15] >>> 3);
                sigma1 = rotateRight32(schedule[round - 2], 17) ^ rotateRight32(schedule[round - 2], 19) ^ (schedule[round - 2] >>> 10);
                schedule[round] = (schedule[round - 16] + sigma0 + schedule[round - 7] + sigma1) | 0;
            }
            a = state[0]; b = state[1]; c = state[2]; d = state[3];
            e = state[4]; f = state[5]; g = state[6]; h = state[7];
            for (round = 0; round < 64; round++) {
                temp1 = (h + (rotateRight32(e, 6) ^ rotateRight32(e, 11) ^ rotateRight32(e, 25)) +
                    ((e & f) ^ (~e & g)) + SHA256_ROUND_CONSTANTS[round] + schedule[round]) | 0;
                temp2 = ((rotateRight32(a, 2) ^ rotateRight32(a, 13) ^ rotateRight32(a, 22)) +
                    ((a & b) ^ (a & c) ^ (b & c))) | 0;
                h = g; g = f; f = e; e = (d + temp1) | 0;
                d = c; c = b; b = a; a = (temp1 + temp2) | 0;
            }
            state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0;
            state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
            state[4] = (state[4] + e) | 0; state[5] = (state[5] + f) | 0;
            state[6] = (state[6] + g) | 0; state[7] = (state[7] + h) | 0;
        }
        for (round = 0; round < 8; round++) {
            digest.push((state[round] >>> 24) & 255, (state[round] >>> 16) & 255, (state[round] >>> 8) & 255, state[round] & 255);
        }
        return digest;
    }

    // HMAC-SHA256 (RFC 2104) on byte arrays.
    function hmacSha256(keyBytes, messageBytes) {
        var blockKey = keyBytes.length > 64 ? sha256Bytes(keyBytes) : keyBytes.slice(0);
        var innerPad = [], outerPad = [], index;
        while (blockKey.length < 64) { blockKey.push(0); }
        for (index = 0; index < 64; index++) {
            innerPad.push(blockKey[index] ^ 0x36);
            outerPad.push(blockKey[index] ^ 0x5c);
        }
        return sha256Bytes(outerPad.concat(sha256Bytes(innerPad.concat(messageBytes))));
    }

    // String -> UTF-8 byte array (the signing string is ASCII in practice).
    function stringToUtf8Bytes(text) {
        var bytes = [], index, code;
        for (index = 0; index < text.length; index++) {
            code = text.charCodeAt(index);
            if (code < 0x80) {
                bytes.push(code);
            }
            else if (code < 0x800) {
                bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
            }
            else {
                bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
            }
        }
        return bytes;
    }

    // ---------------------------------------------------------------- 256-bit integers
    // 32 big-endian bytes -> 16 little-endian limbs.
    function bigIntFromBytes(bytes) {
        var limbs = [], index;
        for (index = 0; index < LIMB_COUNT; index++) {
            limbs.push(bytes[31 - 2 * index] + 256 * bytes[30 - 2 * index]);
        }
        return limbs;
    }

    // 16 little-endian limbs -> 32 big-endian bytes.
    function bigIntToBytes(limbs) {
        var bytes = [], index;
        for (index = LIMB_COUNT - 1; index >= 0; index--) {
            bytes.push(Math.floor(limbs[index] / 256), limbs[index] % 256);
        }
        return bytes;
    }

    // 64 hex characters -> limbs.
    function bigIntFromHex(hexString) {
        var bytes = [], index;
        for (index = 0; index < 64; index += 2) {
            bytes.push(parseInt(hexString.substr(index, 2), 16));
        }
        return bigIntFromBytes(bytes);
    }

    // Returns 1 if first > second, -1 if first < second, 0 if equal.
    function compareBigInt(first, second) {
        var index;
        for (index = LIMB_COUNT - 1; index >= 0; index--) {
            if (first[index] !== second[index]) { return first[index] > second[index] ? 1 : -1; }
        }
        return 0;
    }

    function isBigIntZero(number) {
        var index;
        for (index = 0; index < LIMB_COUNT; index++) {
            if (number[index]) { return false; }
        }
        return true;
    }

    // Value of bit "bitIndex" (0 = least significant).
    function getBit(number, bitIndex) {
        return (number[bitIndex >> 4] >> (bitIndex & 15)) & 1;
    }

    // first - second, assuming first >= second.
    function subtractBigInt(first, second) {
        var result = [], index, difference, borrow = 0;
        for (index = 0; index < LIMB_COUNT; index++) {
            difference = first[index] - second[index] - borrow;
            if (difference < 0) { difference += LIMB_BASE; borrow = 1; } else { borrow = 0; }
            result.push(difference);
        }
        return result;
    }

    // (first + second) mod modulus, with first, second < modulus.
    function addModular(first, second, modulus) {
        var result = [], index, sum, carry = 0;
        for (index = 0; index < LIMB_COUNT; index++) {
            sum = first[index] + second[index] + carry;
            carry = sum >= LIMB_BASE ? 1 : 0;
            result.push(sum - carry * LIMB_BASE);
        }
        return (carry || compareBigInt(result, modulus) >= 0) ? subtractBigInt(result, modulus) : result;
    }

    // (first - second) mod modulus, with first, second < modulus.
    function subtractModular(first, second, modulus) {
        if (compareBigInt(first, second) >= 0) { return subtractBigInt(first, second); }
        return addModular(subtractBigInt(modulus, second), first, modulus);
    }

    // ---------------------------------------------------------------- Montgomery field
    // Arithmetic modulo an odd modulus m, with values kept in "Montgomery form"
    // (x * R mod m, R = 2^256). Constants are precomputed for P-256:
    //   rModHex          R mod m       (the number 1 in Montgomery form)
    //   rSquaredModHex   R^2 mod m     (used to convert into Montgomery form)
    //   negInverseLimb   -m^-1 mod 2^16
    function MontgomeryField(modulusHex, rModHex, rSquaredModHex, negInverseLimb) {
        this.modulus = bigIntFromHex(modulusHex);
        this.oneMontgomery = bigIntFromHex(rModHex);
        this.rSquared = bigIntFromHex(rSquaredModHex);
        this.negInverseLimb = negInverseLimb;
    }

    // Montgomery product: first * second * R^-1 mod m (CIOS algorithm).
    // Intermediate values stay below 2^53, so plain JavaScript numbers are exact.
    MontgomeryField.prototype.multiply = function (first, second) {
        var modulus = this.modulus, accumulator = [], outer, inner, value, carry, reductionFactor;
        for (outer = 0; outer < LIMB_COUNT + 2; outer++) { accumulator.push(0); }

        for (outer = 0; outer < LIMB_COUNT; outer++) {
            // accumulator += first[outer] * second
            carry = 0;
            for (inner = 0; inner < LIMB_COUNT; inner++) {
                value = accumulator[inner] + first[outer] * second[inner] + carry;
                carry = Math.floor(value / LIMB_BASE);
                accumulator[inner] = value - carry * LIMB_BASE;
            }
            value = accumulator[LIMB_COUNT] + carry;
            carry = Math.floor(value / LIMB_BASE);
            accumulator[LIMB_COUNT] = value - carry * LIMB_BASE;
            accumulator[LIMB_COUNT + 1] += carry;

            // accumulator += reductionFactor * modulus, which zeroes the lowest limb,
            // then shift everything down by one limb.
            reductionFactor = (accumulator[0] * this.negInverseLimb) % LIMB_BASE;
            value = accumulator[0] + reductionFactor * modulus[0];
            carry = Math.floor(value / LIMB_BASE);
            for (inner = 1; inner < LIMB_COUNT; inner++) {
                value = accumulator[inner] + reductionFactor * modulus[inner] + carry;
                carry = Math.floor(value / LIMB_BASE);
                accumulator[inner - 1] = value - carry * LIMB_BASE;
            }
            value = accumulator[LIMB_COUNT] + carry;
            carry = Math.floor(value / LIMB_BASE);
            accumulator[LIMB_COUNT - 1] = value - carry * LIMB_BASE;
            accumulator[LIMB_COUNT] = accumulator[LIMB_COUNT + 1] + carry;
            accumulator[LIMB_COUNT + 1] = 0;
        }
        value = accumulator.slice(0, LIMB_COUNT);
        return (accumulator[LIMB_COUNT] || compareBigInt(value, modulus) >= 0) ? subtractBigInt(value, modulus) : value;
    };

    MontgomeryField.prototype.toMontgomery = function (number) {
        return this.multiply(number, this.rSquared);
    };

    MontgomeryField.prototype.fromMontgomery = function (number) {
        var plainOne = [1], index;
        for (index = 1; index < LIMB_COUNT; index++) { plainOne.push(0); }
        return this.multiply(number, plainOne);
    };

    MontgomeryField.prototype.add = function (first, second) {
        return addModular(first, second, this.modulus);
    };

    MontgomeryField.prototype.subtract = function (first, second) {
        return subtractModular(first, second, this.modulus);
    };

    // Modular inverse by Fermat's little theorem: number^(m-2) mod m (m is prime).
    MontgomeryField.prototype.invert = function (numberMontgomery) {
        var two = bigIntFromHex('0000000000000000000000000000000000000000000000000000000000000002');
        var exponent = subtractBigInt(this.modulus, two);
        var result = this.oneMontgomery, bitIndex;
        for (bitIndex = 255; bitIndex >= 0; bitIndex--) {
            result = this.multiply(result, result);
            if (getBit(exponent, bitIndex)) { result = this.multiply(result, numberMontgomery); }
        }
        return result;
    };

    // ---------------------------------------------------------------- curve P-256
    // Field of coordinates (modulo p) and field of scalars (modulo n, the curve order).
    var COORDINATE_FIELD = new MontgomeryField(
        'ffffffff00000001000000000000000000000000ffffffffffffffffffffffff',
        '00000000fffffffeffffffffffffffffffffffff000000000000000000000001',
        '00000004fffffffdfffffffffffffffefffffffbffffffff0000000000000003', 1);
    var SCALAR_FIELD = new MontgomeryField(
        'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
        '00000000ffffffff00000000000000004319055258e8617b0c46353d039cdaaf',
        '66e12d94f3d956202845b2392b6bec594699799c49bd6fa683244c95be79eea2', 48207);
    var CURVE_ORDER = SCALAR_FIELD.modulus;

    // Generator point G, in Montgomery form.
    var GENERATOR_X = COORDINATE_FIELD.toMontgomery(bigIntFromHex('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'));
    var GENERATOR_Y = COORDINATE_FIELD.toMontgomery(bigIntFromHex('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'));

    // Points are in Jacobian coordinates [X, Y, Z] (affine x = X/Z^2, y = Y/Z^3), which
    // avoids one modular inversion per operation.

    // 2 * point. Formula "dbl-2001-b" (curve parameter a = -3).
    function doublePoint(point) {
        var field = COORDINATE_FIELD, x = point[0], y = point[1], z = point[2];
        var zSquared = field.multiply(z, z);
        var ySquared = field.multiply(y, y);
        var xTimesYSquared = field.multiply(x, ySquared);
        var product = field.multiply(field.subtract(x, zSquared), field.add(x, zSquared));
        var slope = field.add(field.add(product, product), product);                 // 3(x - z^2)(x + z^2)
        var fourXy2 = field.add(xTimesYSquared, xTimesYSquared);
        fourXy2 = field.add(fourXy2, fourXy2);
        var newX = field.subtract(field.multiply(slope, slope), field.add(fourXy2, fourXy2));
        var yPlusZ = field.add(y, z);
        var newZ = field.subtract(field.subtract(field.multiply(yPlusZ, yPlusZ), ySquared), zSquared);
        var eightY4 = field.multiply(ySquared, ySquared);
        eightY4 = field.add(eightY4, eightY4);
        eightY4 = field.add(eightY4, eightY4);
        eightY4 = field.add(eightY4, eightY4);
        var newY = field.subtract(field.multiply(slope, field.subtract(fourXy2, newX)), eightY4);
        return [newX, newY, newZ];
    }

    // point + G. Mixed addition "madd-2007-bl" (G has Z = 1).
    function addGeneratorToPoint(point) {
        var field = COORDINATE_FIELD, x = point[0], y = point[1], z = point[2];
        var zSquared = field.multiply(z, z);
        var generatorXScaled = field.multiply(GENERATOR_X, zSquared);
        var generatorYScaled = field.multiply(field.multiply(GENERATOR_Y, z), zSquared);
        var deltaX = field.subtract(generatorXScaled, x);
        var deltaXSquared = field.multiply(deltaX, deltaX);
        var fourDeltaXSquared = field.add(deltaXSquared, deltaXSquared);
        fourDeltaXSquared = field.add(fourDeltaXSquared, fourDeltaXSquared);
        var deltaXCubedTimes4 = field.multiply(deltaX, fourDeltaXSquared);
        var twiceDeltaY = field.subtract(generatorYScaled, y);
        twiceDeltaY = field.add(twiceDeltaY, twiceDeltaY);
        var xScaled = field.multiply(x, fourDeltaXSquared);
        var newX = field.subtract(field.subtract(field.multiply(twiceDeltaY, twiceDeltaY), deltaXCubedTimes4),
            field.add(xScaled, xScaled));
        var yTerm = field.multiply(y, deltaXCubedTimes4);
        var newY = field.subtract(field.multiply(twiceDeltaY, field.subtract(xScaled, newX)), field.add(yTerm, yTerm));
        var zPlusDeltaX = field.add(z, deltaX);
        var newZ = field.subtract(field.subtract(field.multiply(zPlusDeltaX, zPlusDeltaX), zSquared), deltaXSquared);
        return [newX, newY, newZ];
    }

    // scalar * G with "double and add" from the most significant bit.
    // Returns only the affine x coordinate (plain form), which is all ECDSA needs.
    function multiplyGeneratorAffineX(scalar) {
        var bitIndex = 255, point, zInverse;
        while (!getBit(scalar, bitIndex)) { bitIndex--; }
        point = [GENERATOR_X, GENERATOR_Y, COORDINATE_FIELD.oneMontgomery];   // highest bit = G
        for (bitIndex = bitIndex - 1; bitIndex >= 0; bitIndex--) {
            point = doublePoint(point);
            if (getBit(scalar, bitIndex)) { point = addGeneratorToPoint(point); }
        }
        zInverse = COORDINATE_FIELD.invert(point[2]);
        return COORDINATE_FIELD.fromMontgomery(
            COORDINATE_FIELD.multiply(point[0], COORDINATE_FIELD.multiply(zInverse, zInverse)));
    }

    // ---------------------------------------------------------------- key parsing
    // OID 1.2.840.10045.3.1.7 (prime256v1 / P-256), DER-encoded.
    var P256_CURVE_OID_DER = [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
    // "INTEGER 1, OCTET STRING of 32 bytes": header right before the private scalar,
    // identical in SEC 1 ("EC PRIVATE KEY") and in PKCS#8 ("PRIVATE KEY") keys.
    var PRIVATE_SCALAR_HEADER_DER = [0x02, 0x01, 0x01, 0x04, 0x20];

    function indexOfBytes(haystack, needle) {
        var start, offset;
        for (start = 0; start + needle.length <= haystack.length; start++) {
            for (offset = 0; offset < needle.length && haystack[start + offset] === needle[offset]; offset++) { }
            if (offset === needle.length) { return start; }
        }
        return -1;
    }

    // PEM (or base64 body) -> 32-byte private scalar "d".
    function parsePrivateKey(pemText) {
        var base64Body = String(pemText).replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '');
        var derBytes = base64ToBytes(base64Body), headerPosition;
        if (indexOfBytes(derBytes, P256_CURVE_OID_DER) < 0) {
            throw 'EC key is not on curve P-256 (prime256v1)';
        }
        headerPosition = indexOfBytes(derBytes, PRIVATE_SCALAR_HEADER_DER);
        if (headerPosition < 0) {
            throw 'Cannot find the EC private scalar in the key';
        }
        return derBytes.slice(headerPosition + PRIVATE_SCALAR_HEADER_DER.length,
            headerPosition + PRIVATE_SCALAR_HEADER_DER.length + 32);
    }

    // ---------------------------------------------------------------- ECDSA signature
    // Big-endian unsigned bytes -> DER INTEGER (minimal length, positive).
    function encodeDerInteger(bytes) {
        var content = bytes.slice(0);
        while (content.length > 1 && content[0] === 0 && content[1] < 0x80) { content.shift(); }
        if (content[0] >= 0x80) { content.unshift(0); }
        return [0x02, content.length].concat(content);
    }

    // Signs "message" with the private scalar. Returns a DER signature (byte array):
    // SEQUENCE { INTEGER r, INTEGER s }.
    function signMessage(privateScalarBytes, message) {
        var hashAsNumber = bigIntFromBytes(sha256Bytes(stringToUtf8Bytes(message)));
        var privateScalar = bigIntFromBytes(privateScalarBytes);
        var privateScalarMontgomery, hashReducedBytes, nonceV = [], nonceK = [], index;
        var nonce, pointX, signatureR, signatureS, derBody;

        if (compareBigInt(hashAsNumber, CURVE_ORDER) >= 0) {
            hashAsNumber = subtractBigInt(hashAsNumber, CURVE_ORDER);
        }
        hashReducedBytes = bigIntToBytes(hashAsNumber);
        privateScalarMontgomery = SCALAR_FIELD.toMontgomery(privateScalar);

        // RFC 6979 section 3.2: derive the nonce from the key and the message hash.
        for (index = 0; index < 32; index++) { nonceV.push(1); nonceK.push(0); }
        nonceK = hmacSha256(nonceK, nonceV.concat([0], privateScalarBytes, hashReducedBytes));
        nonceV = hmacSha256(nonceK, nonceV);
        nonceK = hmacSha256(nonceK, nonceV.concat([1], privateScalarBytes, hashReducedBytes));
        nonceV = hmacSha256(nonceK, nonceV);

        for (;;) {
            nonceV = hmacSha256(nonceK, nonceV);
            nonce = bigIntFromBytes(nonceV);

            if (!isBigIntZero(nonce) && compareBigInt(nonce, CURVE_ORDER) < 0) {
                // r = (nonce * G).x mod n
                pointX = multiplyGeneratorAffineX(nonce);
                signatureR = compareBigInt(pointX, CURVE_ORDER) >= 0 ? subtractBigInt(pointX, CURVE_ORDER) : pointX;

                if (!isBigIntZero(signatureR)) {
                    // s = nonce^-1 * (hash + r * privateKey) mod n
                    signatureS = SCALAR_FIELD.fromMontgomery(SCALAR_FIELD.multiply(
                        SCALAR_FIELD.invert(SCALAR_FIELD.toMontgomery(nonce)),
                        SCALAR_FIELD.add(SCALAR_FIELD.toMontgomery(hashAsNumber),
                            SCALAR_FIELD.multiply(SCALAR_FIELD.toMontgomery(signatureR), privateScalarMontgomery))));

                    if (!isBigIntZero(signatureS)) {
                        derBody = encodeDerInteger(bigIntToBytes(signatureR)).concat(encodeDerInteger(bigIntToBytes(signatureS)));
                        return [0x30, derBody.length].concat(derBody);
                    }
                }
            }
            // Candidate rejected (practically never happens): next candidate per RFC 6979.
            nonceK = hmacSha256(nonceK, nonceV.concat([0]));
            nonceV = hmacSha256(nonceK, nonceV);
        }
    }

    return {
        parsePrivateKey: parsePrivateKey,
        signToBase64: function (privateScalarBytes, message) {
            return bytesToBase64(signMessage(privateScalarBytes, message));
        }
    };
}());
// ===== END EcdsaP256 =====

// =====================================================================================
//  4. INTERSIGHT AUTHENTICATION
// =====================================================================================
//  hs2019 : API key v3 (EC P-256), ECDSA computed by EcdsaP256 above
//  rsa    : API key v2, HTTP signature "rsa-sha256" computed by Zabbix sign()
//  oauth  : OAuth2 client credentials on /iam/token, then "Authorization: Bearer"

var intersightHttp = new HttpRequest();
var rsaPrivateKeyPem = null;
var ecPrivateScalar = null;
var oauthAccessToken = null;

// Rebuilds a multi-line PEM from a one-line macro value (Zabbix sign() needs PEM).
function buildRsaPem(keyText) {
    var normalized = String(keyText).replace(/\\n/g, '\n'), base64Body, lines = [], index;
    if (normalized.indexOf('-----BEGIN') === 0) { return normalized; }
    base64Body = normalized.replace(/\s+/g, '');
    for (index = 0; index < base64Body.length; index += 64) { lines.push(base64Body.substr(index, 64)); }
    return '-----BEGIN RSA PRIVATE KEY-----\n' + lines.join('\n') + '\n-----END RSA PRIVATE KEY-----\n';
}

function requestOAuthAccessToken() {
    var responseBody, statusCode, tokenResponse;
    intersightHttp.clearHeader();
    intersightHttp.addHeader('Content-Type: application/x-www-form-urlencoded');
    intersightHttp.addHeader('Accept: application/json');
    responseBody = intersightHttp.post('https://' + CONFIG.apiHost + INTERSIGHT_PATHS.oauthToken,
        'grant_type=client_credentials' +
        '&client_id=' + encodeURIComponent(itemParameters.client_id) +
        '&client_secret=' + encodeURIComponent(itemParameters.client_secret));
    apiCallCount++;
    statusCode = intersightHttp.getStatus();
    if (statusCode !== 200) {
        throw 'OAuth2 token request -> HTTP ' + statusCode + ': ' + String(responseBody).substring(0, 200);
    }
    tokenResponse = JSON.parse(responseBody);
    if (!tokenResponse.access_token) { throw 'OAuth2 token response without access_token'; }
    return tokenResponse.access_token;
}

// Prepares the credentials once per run, according to the auth mode.
function initializeAuthentication() {
    if (CONFIG.authMode === 'oauth') {
        oauthAccessToken = requestOAuthAccessToken();
    }
    else if (CONFIG.authMode === 'hs2019' || CONFIG.authMode === 'ec') {
        CONFIG.authMode = 'hs2019';
        ecPrivateScalar = EcdsaP256.parsePrivateKey(itemParameters.private_key);
    }
    else if (CONFIG.authMode === 'rsa') {
        if (String(itemParameters.private_key).indexOf('EC PRIVATE KEY') !== -1) {
            throw 'EC key given with auth=rsa: set {$INTERSIGHT.AUTH} to hs2019';
        }
        rsaPrivateKeyPem = buildRsaPem(itemParameters.private_key);
    }
    else {
        throw 'Unknown auth mode: ' + CONFIG.authMode;
    }
}

// Adds the authentication headers for one request.
//   httpMethod       'GET' or 'POST'
//   pathWithQuery    path + query string, exactly as sent (it is part of the signature)
//   requestBody      body string ('' for GET)
function addAuthenticationHeaders(httpMethod, pathWithQuery, requestBody) {
    var requestTarget, httpDate, bodyDigest, signingString, signature, signingStart;

    if (CONFIG.authMode === 'oauth') {
        intersightHttp.addHeader('Authorization: Bearer ' + oauthAccessToken);
        return;
    }

    // HTTP signature (draft-cavage-http-signatures): the signed headers are rebuilt
    // here as "name: value" lines, in the order announced in the "headers" parameter.
    requestTarget = '(request-target): ' + httpMethod.toLowerCase() + ' ' + pathWithQuery;
    httpDate = formatHttpDate(new Date());
    bodyDigest = 'SHA-256=' + hexToBase64(sha256(requestBody));   // digest even for empty GET bodies

    intersightHttp.addHeader('Host: ' + CONFIG.apiHost);
    intersightHttp.addHeader('Date: ' + httpDate);
    intersightHttp.addHeader('Digest: ' + bodyDigest);

    if (CONFIG.authMode === 'hs2019') {
        signingString = requestTarget + '\n' + 'host: ' + CONFIG.apiHost + '\n' +
            'date: ' + httpDate + '\n' + 'digest: ' + bodyDigest;
        signingStart = new Date().getTime();
        signature = EcdsaP256.signToBase64(ecPrivateScalar, signingString);
        signingTimeMs += new Date().getTime() - signingStart;
        intersightHttp.addHeader('Authorization: Signature keyId="' + itemParameters.key_id + '",' +
            'algorithm="hs2019",headers="(request-target) host date digest",signature="' + signature + '"');
    }
    else {
        signingString = requestTarget + '\n' + 'date: ' + httpDate + '\n' +
            'digest: ' + bodyDigest + '\n' + 'host: ' + CONFIG.apiHost;
        signature = sign('sha256', rsaPrivateKeyPem, signingString);
        // The Zabbix documentation does not state the output encoding: convert if hex.
        if (/^[0-9a-fA-F]+$/.test(signature)) { signature = hexToBase64(signature); }
        intersightHttp.addHeader('Authorization: Signature keyId="' + itemParameters.key_id + '",' +
            'algorithm="rsa-sha256",headers="(request-target) date digest host",signature="' + signature + '"');
    }
}

// =====================================================================================
//  5. INTERSIGHT API CLIENT
// =====================================================================================

// Sends one authenticated request and returns the parsed JSON response.
// Throws on any HTTP status other than 200.
function callIntersightApi(httpMethod, pathWithQuery, bodyObject) {
    var requestBody = bodyObject ? JSON.stringify(bodyObject) : '';
    var url = 'https://' + CONFIG.apiHost + pathWithQuery;
    var responseBody, statusCode;

    intersightHttp.clearHeader();
    intersightHttp.addHeader('Accept: application/json');
    intersightHttp.addHeader('Content-Type: application/json');
    addAuthenticationHeaders(httpMethod, pathWithQuery, requestBody);

    responseBody = (httpMethod === 'GET') ? intersightHttp.get(url) : intersightHttp.post(url, requestBody);
    apiCallCount++;
    statusCode = intersightHttp.getStatus();
    if (statusCode !== 200) {
        throw httpMethod + ' ' + pathWithQuery.split('?')[0] + ' -> HTTP ' + statusCode + ': ' +
            String(responseBody).substring(0, 200);
    }
    return JSON.parse(responseBody);
}

// Reads every page of an Intersight list endpoint ($top / $skip paging).
//   odataFilter   optional $filter expression
//   odataSelect   optional comma-separated $select field list
function listAllObjects(path, odataFilter, odataSelect) {
    var allObjects = [], skip = 0, page, queryString;
    do {
        queryString = '?$top=' + PAGE_SIZE + '&$skip=' + skip +
            (odataFilter ? '&$filter=' + encodeURIComponent(odataFilter) : '') +
            (odataSelect ? '&$select=' + encodeURIComponent(odataSelect) : '');
        page = callIntersightApi('GET', path + queryString);
        allObjects = allObjects.concat(page.Results || []);
        skip += PAGE_SIZE;
    } while (page.Results && page.Results.length === PAGE_SIZE && skip < MAX_ITEMS_PER_LIST);
    return allObjects;
}

// Name under which an attribute appears in the result rows. Dotted attributes are read
// through a "nested-field" virtual column renamed with underscores (host.name ->
// host_name), the pattern used by the intersight-grafana dashboards
// (github.com/3191110276/intersight-grafana). Plain attributes ("name") are grouped
// on directly.
function rowFieldName(attributeName) {
    return attributeName.replace(/\./g, '_');
}

function buildGroupBySpec(attributeNames) {
    var dimensions = [], virtualColumns = [], index, attributeName;
    for (index = 0; index < attributeNames.length; index++) {
        attributeName = attributeNames[index];
        if (attributeName.indexOf('.') === -1) {
            dimensions.push(attributeName);
        }
        else {
            dimensions.push(rowFieldName(attributeName));
            virtualColumns.push({
                type: 'nested-field', columnName: attributeName, outputName: rowFieldName(attributeName),
                expectedType: 'STRING', path: '$'
            });
        }
    }
    return { dimensions: dimensions, virtualColumns: virtualColumns };
}

// Runs a Druid "groupBy" query over the telemetry window, for one instrument
// (e.g. "hw.host"), and returns the result rows as flat objects.
function runTelemetryGroupBy(dataSource, instrumentName, groupByAttributes, aggregations, timeInterval) {
    var groupBy = buildGroupBySpec(groupByAttributes);
    var query = {
        queryType: 'groupBy',
        dataSource: dataSource,
        granularity: 'all',                 // one result per group for the whole window
        intervals: [timeInterval],
        dimensions: groupBy.dimensions,
        filter: { type: 'selector', dimension: 'instrument.name', value: instrumentName },
        aggregations: aggregations
    };
    if (groupBy.virtualColumns.length) { query.virtualColumns = groupBy.virtualColumns; }
    var response = callIntersightApi('POST', INTERSIGHT_PATHS.telemetryQuery, query);
    var rows = [], index;
    for (index = 0; index < response.length; index++) {
        // Druid returns {event: {...}}; other shapes are accepted defensively.
        rows.push(response[index].event || response[index].result || response[index]);
    }
    return rows;
}

// =====================================================================================
//  6. TELEMETRY DEFINITIONS
// =====================================================================================
//  One entry per Druid query. To add a metric: add an entry here (documented fields only,
//  see docs/intersight_metrics.json), add the field to the device object in
//  buildCommonDeviceFields(), then add a dependent item in the template.
//
//    instrument     Druid "instrument.name" value
//    dataSource     'physical' (PhysicalEntities) or 'network' (NetworkInterfaces), as
//                   stated on the instrument's "Supported Metrics" page
//    perComponent   true = also grouped by the component attribute "name" (one row per
//                   sensor / fan / PSU / DIMM / port)
//    aggregations   Druid aggregators on the fields of the "Available metrics" tables:
//                   <metric> (Sum), <metric>_count (Count), <metric>_max / _min.
//                   Average of a gauge = Sum / Count.
//    storeRow       copies one result row into the telemetry of its device
//
//  A metric that a device does not report simply returns no row: the item stays empty.

var TELEMETRY_QUERIES = [
    {
        // Page "hw-host". Reported by blades, racks and FI.
        instrument: 'hw.host',
        dataSource: 'physical',
        perComponent: false,
        aggregations: [
            { type: 'doubleSum', name: 'powerSum', fieldName: 'hw.host.power' },
            { type: 'longSum', name: 'powerCount', fieldName: 'hw.host.power_count' },
            { type: 'doubleMax', name: 'powerMax', fieldName: 'hw.host.power_max' }
        ],
        storeRow: function (row, deviceTelemetry) {
            deviceTelemetry.power_w = roundToOneDecimal(divideOrNull(row.powerSum, row.powerCount));
            deviceTelemetry.power_max_w = roundToOneDecimal(numberOrNull(row.powerMax));
        }
    },
    {
        // Page "hw-temperature". Grouped per sensor, to compare each sensor with its OWN
        // thresholds (a fixed threshold does not fit CPU, inlet and PSU sensors at once).
        //   limit_high_critical: FI, imm-blade-mqtt, imm-ism-rack-mqtt
        //   limit_high_degraded (upper non critical): imm-blade-mqtt, imm-ism-rack-mqtt
        // CPU temperatures are only reported while the host is powered on.
        instrument: 'hw.temperature',
        dataSource: 'physical',
        perComponent: true,
        aggregations: [
            { type: 'doubleMax', name: 'temperatureMax', fieldName: 'hw.temperature_max' },
            { type: 'doubleMin', name: 'highCriticalLimit', fieldName: 'hw.temperature.limit_high_critical_min' },
            { type: 'doubleMin', name: 'highDegradedLimit', fieldName: 'hw.temperature.limit_high_degraded_min' }
        ],
        storeRow: function (row, deviceTelemetry) {
            var temperature = numberOrNull(row.temperatureMax);
            var highCriticalLimit = numberOrNull(row.highCriticalLimit);
            var highDegradedLimit = numberOrNull(row.highDegradedLimit);
            deviceTelemetry.temp_max = maxIgnoringNull(deviceTelemetry.temp_max, roundToOneDecimal(temperature));
            if (temperature === null) { return; }
            // Margins = distance to each threshold of the sensor (negative = exceeded).
            if (highCriticalLimit !== null && highCriticalLimit > 0) {
                deviceTelemetry.temp_margin_min = minIgnoringNull(deviceTelemetry.temp_margin_min,
                    roundToOneDecimal(highCriticalLimit - temperature));
            }
            if (highDegradedLimit !== null && highDegradedLimit > 0) {
                deviceTelemetry.temp_margin_degraded_min = minIgnoringNull(deviceTelemetry.temp_margin_degraded_min,
                    roundToOneDecimal(highDegradedLimit - temperature));
            }
        }
    },
    {
        // Page "hw-fan". Speed: chassis, racks, FI. Grouped per fan, to compare each fan with
        // its own lower critical limit (imm-chassis-mqtt-*, imm-ism-rack-mqtt).
        instrument: 'hw.fan',
        dataSource: 'physical',
        perComponent: true,
        aggregations: [
            { type: 'doubleMin', name: 'fanSpeedMin', fieldName: 'hw.fan.speed_min' },
            { type: 'doubleMax', name: 'fanSpeedMax', fieldName: 'hw.fan.speed_max' },
            { type: 'doubleMax', name: 'lowCriticalLimit', fieldName: 'hw.fan.speed.limit_low_critical_max' }
        ],
        storeRow: function (row, deviceTelemetry) {
            var speedMin = numberOrNull(row.fanSpeedMin);
            var lowCriticalLimit = numberOrNull(row.lowCriticalLimit);
            deviceTelemetry.fan_min = minIgnoringNull(deviceTelemetry.fan_min, roundToOneDecimal(speedMin));
            deviceTelemetry.fan_max = maxIgnoringNull(deviceTelemetry.fan_max, roundToOneDecimal(numberOrNull(row.fanSpeedMax)));
            // Margin in rpm above the fan's own lower critical limit (negative = too slow).
            if (speedMin !== null && lowCriticalLimit !== null && lowCriticalLimit > 0) {
                deviceTelemetry.fan_margin_min = minIgnoringNull(deviceTelemetry.fan_margin_min,
                    roundToOneDecimal(speedMin - lowCriticalLimit));
            }
        }
    },
    {
        // Page "hw-power_supply".
        //   hw.power (power drawn by the PSU) and hw.power_out: chassis, racks and FI.
        //   hw.power_supply.utilization: FI only.
        instrument: 'hw.power_supply',
        dataSource: 'physical',
        perComponent: true,
        aggregations: [
            { type: 'doubleMax', name: 'utilizationMax', fieldName: 'hw.power_supply.utilization_max' },
            { type: 'doubleSum', name: 'outputPowerSum', fieldName: 'hw.power_out' },
            { type: 'longSum', name: 'outputPowerCount', fieldName: 'hw.power_out_count' },
            { type: 'doubleSum', name: 'inputPowerSum', fieldName: 'hw.power' },
            { type: 'longSum', name: 'inputPowerCount', fieldName: 'hw.power_count' }
        ],
        storeRow: function (row, deviceTelemetry, componentName) {
            var rawUtilization = numberOrNull(row.utilizationMax);
            var utilization = checkPercentage('hw.power_supply.utilization',
                rawUtilization === null ? null : roundToOneDecimal(rawUtilization * CONFIG.percentScale), '{$INTERSIGHT.PERCENT.SCALE}');
            var outputPower = divideOrNull(row.outputPowerSum, row.outputPowerCount);
            var inputPower = divideOrNull(row.inputPowerSum, row.inputPowerCount);
            var powerSupply = { name: componentName };
            setIfPresent(powerSupply, 'util', utilization);
            setIfPresent(powerSupply, 'out_w', roundToOneDecimal(outputPower));
            setIfPresent(powerSupply, 'in_w', roundToOneDecimal(inputPower));
            deviceTelemetry.powerSuppliesByName[componentName] = powerSupply;
            deviceTelemetry.psu_util_max = maxIgnoringNull(deviceTelemetry.psu_util_max, utilization);
            // Total power drawn by the PSUs: power of the device when hw.host.power is not
            // reported (IMM chassis).
            if (inputPower !== null) {
                deviceTelemetry.psu_input_total_w = (deviceTelemetry.psu_input_total_w || 0) + inputPower;
            }
        }
    },
    {
        // Page "hw-memory". Blades and racks only, host powered on.
        // A non-zero sum over the window means errors were reported during the window.
        instrument: 'hw.memory',
        dataSource: 'physical',
        perComponent: true,
        aggregations: [
            { type: 'doubleSum', name: 'correctableErrors', fieldName: 'hw.errors_correctable_ecc_errors' },
            { type: 'doubleSum', name: 'uncorrectableErrors', fieldName: 'hw.errors_uncorrectable_ecc_errors' }
        ],
        storeRow: function (row, deviceTelemetry, componentName) {
            var correctable = numberOrNull(row.correctableErrors);
            var uncorrectable = numberOrNull(row.uncorrectableErrors);
            if (correctable === null && uncorrectable === null) { return; }
            deviceTelemetry.mem_ecc_correctable = (deviceTelemetry.mem_ecc_correctable || 0) + (correctable || 0);
            deviceTelemetry.mem_ecc_uncorrectable = (deviceTelemetry.mem_ecc_uncorrectable || 0) + (uncorrectable || 0);
            // Remember which DIMMs had errors, for the operator.
            if ((correctable || 0) + (uncorrectable || 0) > 0) {
                deviceTelemetry.dimmsWithErrors.push(componentName);
            }
        }
    },
    {
        // Page "hw-cpu": "a single aggregated value across all CPUs" of the server.
        // Support: imm-blade-mqtt, imm-ism-rack-mqtt.
        instrument: 'hw.cpu',
        dataSource: 'physical',
        perComponent: false,
        aggregations: [
            { type: 'doubleSum', name: 'utilizationSum', fieldName: 'hw.cpu.utilization_c0' },
            { type: 'longSum', name: 'utilizationCount', fieldName: 'hw.cpu.utilization_c0_count' },
            { type: 'doubleMax', name: 'utilizationMax', fieldName: 'hw.cpu.utilization_c0_max' }
        ],
        storeRow: function (row, deviceTelemetry) {
            var average = divideOrNull(row.utilizationSum, row.utilizationCount);
            var peak = numberOrNull(row.utilizationMax);
            deviceTelemetry.cpu_util = checkPercentage('hw.cpu.utilization_c0',
                average === null ? null : roundToOneDecimal(average * CONFIG.percentScale), '{$INTERSIGHT.PERCENT.SCALE}');
            deviceTelemetry.cpu_util_max = checkPercentage('hw.cpu.utilization_c0',
                peak === null ? null : roundToOneDecimal(peak * CONFIG.percentScale), '{$INTERSIGHT.PERCENT.SCALE}');
        }
    },
    {
        // Page "system-cpu". FI only. Utilization = 100 - idle percentage.
        instrument: 'system.cpu',
        dataSource: 'physical',
        perComponent: false,
        aggregations: [
            { type: 'doubleSum', name: 'idleSum', fieldName: 'system.cpu.utilization_idle' },
            { type: 'longSum', name: 'idleCount', fieldName: 'system.cpu.utilization_idle_count' }
        ],
        storeRow: function (row, deviceTelemetry) {
            var idle = divideOrNull(row.idleSum, row.idleCount);
            if (idle === null) { return; }
            rawIdleValues.push(idle);
            idle = checkPercentage('system.cpu.utilization_idle', idle * CONFIG.percentScale, '{$INTERSIGHT.PERCENT.SCALE}');
            deviceTelemetry.cpu_util = roundToOneDecimal(Math.max(0, 100 - idle));
        }
    },
    {
        // Page "system-memory". FI only.
        instrument: 'system.memory',
        dataSource: 'physical',
        perComponent: false,
        aggregations: [
            { type: 'doubleSum', name: 'utilizationSum', fieldName: 'system.memory.utilization' },
            { type: 'longSum', name: 'utilizationCount', fieldName: 'system.memory.utilization_count' }
        ],
        storeRow: function (row, deviceTelemetry) {
            var average = divideOrNull(row.utilizationSum, row.utilizationCount);
            deviceTelemetry.mem_util = checkPercentage('system.memory.utilization',
                average === null ? null : roundToOneDecimal(average * CONFIG.percentScale), '{$INTERSIGHT.PERCENT.SCALE}');
        }
    },
    {
        // Page "hw-network", dataSource NetworkInterfaces. Blades, racks and FI.
        // Throughput: same formula as the intersight-grafana dashboards (domain
        // "util-bps" panels): bits/s = sum(io_receive) / sum(io_receive_duration) * 8, i.e.
        // bytes over the measured seconds. Link speed: bandwidth.limit, documented in bytes
        // per second, * 8. The port role (hw.network.port.role) lets the template ignore
        // virtual interfaces, as those dashboards do.
        instrument: 'hw.network',
        dataSource: 'network',
        perComponent: true,
        extraAttributes: ['hw.network.port.role'],
        aggregations: [
            { type: 'longSum', name: 'receivedBytes', fieldName: 'hw.network.io_receive' },
            { type: 'doubleSum', name: 'receiveDuration', fieldName: 'hw.network.io_receive_duration' },
            { type: 'longSum', name: 'transmittedBytes', fieldName: 'hw.network.io_transmit' },
            { type: 'doubleSum', name: 'transmitDuration', fieldName: 'hw.network.io_transmit_duration' },
            { type: 'longLast', name: 'linkSpeedBytes', fieldName: 'hw.network.bandwidth.limit' },
            { type: 'doubleSum', name: 'receiveErrors', fieldName: 'hw.errors_network_receive_all' },
            { type: 'doubleSum', name: 'transmitErrors', fieldName: 'hw.errors_network_transmit_all' },
            { type: 'doubleSum', name: 'utilizationSum', fieldName: 'hw.network.bandwidth.utilization_all' },
            { type: 'longSum', name: 'utilizationCount', fieldName: 'hw.network.bandwidth.utilization_all_count' },
            { type: 'doubleMin', name: 'linkUpMin', fieldName: 'hw.network.up_min' }
        ],
        storeRow: function (row, deviceTelemetry, componentName) {
            var receiveRate = divideOrNull(row.receivedBytes, row.receiveDuration);
            var transmitRate = divideOrNull(row.transmittedBytes, row.transmitDuration);
            var linkSpeed = numberOrNull(row.linkSpeedBytes);
            var receiveErrors = numberOrNull(row.receiveErrors), transmitErrors = numberOrNull(row.transmitErrors);
            var linkUpMin = numberOrNull(row.linkUpMin);
            var port = { name: componentName };
            setIfPresent(port, 'role', row[rowFieldName('hw.network.port.role')]);
            setIfPresent(port, 'rx_bps', receiveRate === null ? null : Math.round(receiveRate * 8));
            setIfPresent(port, 'tx_bps', transmitRate === null ? null : Math.round(transmitRate * 8));
            setIfPresent(port, 'speed_bps', linkSpeed === null || linkSpeed <= 0 ? null : linkSpeed * 8);
            var utilization = divideOrNull(row.utilizationSum, row.utilizationCount);
            setIfPresent(port, 'util', checkPercentage('hw.network.bandwidth.utilization_all',
                utilization === null ? null : roundToOneDecimal(utilization * CONFIG.percentScale),
                '{$INTERSIGHT.PERCENT.SCALE}'));
            // Link state over the window: 0 if the link was down at least once (Cisco doc:
            // minimum of an up/down metric = down at least once during the interval).
            if (linkUpMin !== null) { port.up = linkUpMin > 0 ? 1 : 0; }
            // Errors reported during the window (receive + transmit).
            if (receiveErrors !== null || transmitErrors !== null) {
                port.errors = (receiveErrors || 0) + (transmitErrors || 0);
                deviceTelemetry.net_errors = (deviceTelemetry.net_errors || 0) + port.errors;
            }
            deviceTelemetry.portsByName[componentName] = port;
        }
    }
];

// Key of a device in the telemetry map: "<class>|<name>".
function buildTelemetryKey(deviceClass, deviceName) {
    return deviceClass + '|' + deviceName;
}

// Runs every telemetry query. Returns { "<class>|<name>": deviceTelemetry }.
// Rows are grouped by "host.name" and "host.type"; when host.type is missing, the
// class is "any" and the lookup falls back to the name only.
function collectTelemetryByDeviceKey(timeInterval) {
    var telemetryByDeviceKey = {};

    function getDeviceTelemetry(row) {
        var deviceClass = DEVICE_CLASS_BY_HOST_TYPE[row[rowFieldName('host.type')]] || UNKNOWN_DEVICE_CLASS;
        var key = buildTelemetryKey(deviceClass, row[rowFieldName('host.name')]);
        if (!telemetryByDeviceKey[key]) {
            telemetryByDeviceKey[key] = { powerSuppliesByName: {}, portsByName: {}, dimmsWithErrors: [] };
        }
        return telemetryByDeviceKey[key];
    }

    function runOneQuery(query) {
        var dataSource = (query.dataSource === 'network') ? CONFIG.druidNetworkDataSource : CONFIG.druidPhysicalDataSource;
        var attributes = GROUP_BY_ATTRIBUTES.slice(0);
        if (query.perComponent) { attributes.push(CONFIG.druidComponentDimension); }
        attributes = attributes.concat(query.extraAttributes || []);
        var rows = runTelemetryGroupBy(dataSource, query.instrument, attributes, query.aggregations, timeInterval);
        var rowIndex, row, componentName;
        for (rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            row = rows[rowIndex];
            componentName = query.perComponent ? (row[rowFieldName(CONFIG.druidComponentDimension)] || ('component' + rowIndex)) : null;
            query.storeRow(row, getDeviceTelemetry(row), componentName);
        }
    }

    var queryIndex;
    for (queryIndex = 0; queryIndex < TELEMETRY_QUERIES.length; queryIndex++) {
        (function (query) {
            runStepOrRecordError('telemetry ' + query.instrument, function () { runOneQuery(query); });
        }(TELEMETRY_QUERIES[queryIndex]));
    }
    // Idle CPU of every FI at or below 1 with scale 1: almost certainly a 0-1 ratio read as a
    // percentage (it would mean every FI is 99-100 % busy).
    var allIdleAtMostOne = rawIdleValues.length > 0, idleIndex;
    for (idleIndex = 0; idleIndex < rawIdleValues.length; idleIndex++) {
        if (rawIdleValues[idleIndex] > 1) { allIdleAtMostOne = false; }
    }
    if (CONFIG.percentScale === 1 && allIdleAtMostOne) {
        collectedErrors.push('units: system.cpu.utilization_idle <= 1 on every FI: if the Intersight UI shows ' +
            'an idle CPU near 100 %, the values are 0-1 ratios: set {$INTERSIGHT.PERCENT.SCALE} to 100');
    }
    return telemetryByDeviceKey;
}

// =====================================================================================
//  7. DEVICE OBJECTS (inventory + telemetry)
// =====================================================================================

// Identifies a chassis inside its UCS domain: "<registered device Moid>:<chassis id>".
// Chassis ids restart at 1 in each domain, hence the domain prefix.
// Empty string for rack servers (no chassis).
function buildChassisKey(inventoryObject) {
    var domainMoid = (inventoryObject.RegisteredDevice && inventoryObject.RegisteredDevice.Moid) || '';
    var chassisId = inventoryObject.ChassisId;
    if (chassisId === undefined || chassisId === null || String(chassisId) === '0') { return ''; }
    return domainMoid + ':' + chassisId;
}

// Fields shared by servers, chassis and Fabric Interconnects.
function buildCommonDeviceFields(deviceClass, inventoryObject, telemetryByDeviceKey) {
    var device = {
        moid: inventoryObject.Moid,
        name: inventoryObject.Name || inventoryObject.Moid,
        'class': deviceClass,
        model: inventoryObject.Model || 'unknown'
    };
    var alarmSummary = inventoryObject.AlarmSummary || {};
    var telemetry = telemetryByDeviceKey[buildTelemetryKey(deviceClass, device.name)] ||
        telemetryByDeviceKey[buildTelemetryKey(UNKNOWN_DEVICE_CLASS, device.name)];

    setIfPresent(device, 'serial', inventoryObject.Serial);
    setIfPresent(device, 'alarm_critical', numberOrNull(alarmSummary.Critical));
    setIfPresent(device, 'alarm_warning', numberOrNull(alarmSummary.Warning));

    if (telemetry) {
        // Power: hw.host.power when reported, otherwise the power drawn by the PSUs.
        if (numberOrNull(telemetry.power_w) !== null) {
            device.power_w = telemetry.power_w;
            device.power_source = 'host';
        }
        else if (numberOrNull(telemetry.psu_input_total_w) !== null) {
            device.power_w = roundToOneDecimal(telemetry.psu_input_total_w);
            device.power_source = 'psu_input';
        }
        setIfPresent(device, 'power_max_w', telemetry.power_max_w);
        setIfPresent(device, 'temp_max', telemetry.temp_max);
        setIfPresent(device, 'temp_margin_min', telemetry.temp_margin_min);
        setIfPresent(device, 'temp_margin_degraded_min', telemetry.temp_margin_degraded_min);
        setIfPresent(device, 'fan_margin_min', telemetry.fan_margin_min);
        setIfPresent(device, 'net_errors', telemetry.net_errors);
        setIfPresent(device, 'mem_ecc_correctable', telemetry.mem_ecc_correctable);
        setIfPresent(device, 'mem_ecc_uncorrectable', telemetry.mem_ecc_uncorrectable);
        if (telemetry.mem_ecc_correctable !== undefined || telemetry.mem_ecc_uncorrectable !== undefined) {
            device.mem_ecc_dimms = telemetry.dimmsWithErrors.length ? telemetry.dimmsWithErrors.join(', ') : 'none';
        }
        setIfPresent(device, 'cpu_util', telemetry.cpu_util);
        setIfPresent(device, 'cpu_util_max', telemetry.cpu_util_max);
        setIfPresent(device, 'mem_util', telemetry.mem_util);
        setIfPresent(device, 'fan_min', telemetry.fan_min);
        setIfPresent(device, 'fan_max', telemetry.fan_max);
        setIfPresent(device, 'psu_util_max', telemetry.psu_util_max);
    }
    device.psus = telemetry ? objectValues(telemetry.powerSuppliesByName) : [];
    device.ports = telemetry ? objectValues(telemetry.portsByName) : [];
    return device;
}

function buildServerDevice(inventoryObject, telemetryByDeviceKey) {
    var device = buildCommonDeviceFields('server', inventoryObject, telemetryByDeviceKey);
    setIfPresent(device, 'firmware', inventoryObject.Firmware);
    setIfPresent(device, 'mgmt_ip', inventoryObject.MgmtIpAddress);
    if (inventoryObject.OperPowerState) {
        device.power_state = (String(inventoryObject.OperPowerState).toLowerCase() === 'on') ? 1 : 0;
    }
    device.chassis_key = buildChassisKey(inventoryObject);
    // Blade = inside a chassis, or a blade model (UCSB-* / UCSX-*).
    device.is_blade = (device.chassis_key !== '' || /^UCS[BX]/.test(device.model)) ? 1 : 0;
    return device;
}

function buildChassisDevice(inventoryObject, telemetryByDeviceKey) {
    var device = buildCommonDeviceFields('chassis', inventoryObject, telemetryByDeviceKey);
    setIfPresent(device, 'oper_state', inventoryObject.OperState);
    device.chassis_key = buildChassisKey(inventoryObject);
    return device;
}

function buildFabricInterconnectDevice(inventoryObject, telemetryByDeviceKey) {
    var device = buildCommonDeviceFields('fi', inventoryObject, telemetryByDeviceKey);
    setIfPresent(device, 'firmware', inventoryObject.Version || inventoryObject.Firmware);
    setIfPresent(device, 'mgmt_ip', inventoryObject.OutOfBandIpAddress || inventoryObject.ManagementIpAddress);
    return device;
}

function buildDeviceList(inventoryObjects, buildFunction, telemetryByDeviceKey) {
    var devices = [], index;
    for (index = 0; inventoryObjects && index < inventoryObjects.length; index++) {
        devices.push(buildFunction(inventoryObjects[index], telemetryByDeviceKey));
    }
    return devices;
}

// Zabbix requires unique visible host names. Duplicated device names get their serial
// number (or Moid) appended: "srv-a [WZP123]".
function assignUniqueDisplayNames(devices) {
    var occurrencesByName = {}, index;
    for (index = 0; index < devices.length; index++) {
        occurrencesByName[devices[index].name] = (occurrencesByName[devices[index].name] || 0) + 1;
    }
    for (index = 0; index < devices.length; index++) {
        devices[index].display = (occurrencesByName[devices[index].name] > 1)
            ? devices[index].name + ' [' + (devices[index].serial || devices[index].moid) + ']'
            : devices[index].name;
    }
}

// Adds to each chassis the list of its blades (used by the Zabbix 7.4 nested discovery).
function attachBladesToChassis(chassisDevices, serverDevices) {
    var chassisIndex, serverIndex, chassis, server;
    for (chassisIndex = 0; chassisIndex < chassisDevices.length; chassisIndex++) {
        chassis = chassisDevices[chassisIndex];
        chassis.blades = [];
        if (chassis.chassis_key === '') { continue; }
        for (serverIndex = 0; serverIndex < serverDevices.length; serverIndex++) {
            server = serverDevices[serverIndex];
            if (server.chassis_key === chassis.chassis_key) {
                chassis.blades.push({ moid: server.moid, display: server.display, model: server.model });
            }
        }
    }
}

// Distinct (class, model) pairs, with the matching host group name, for the
// per-model aggregates LLD of the parent template.
function listDistinctModels(allDevices) {
    var models = [], alreadyListed = {}, index, groupName, deviceClassGroup;
    for (index = 0; index < allDevices.length; index++) {
        deviceClassGroup = HOST_GROUP_BY_CLASS[allDevices[index]['class']];
        groupName = 'Intersight/' + deviceClassGroup + '/' + allDevices[index].model;
        if (!alreadyListed[groupName]) {
            alreadyListed[groupName] = true;
            models.push({ 'class': deviceClassGroup, model: allDevices[index].model, group: groupName });
        }
    }
    return models;
}

function countAlarmsBySeverity(alarmObjects) {
    var counts = { critical: 0, warning: 0, info: 0 }, index;
    for (index = 0; alarmObjects && index < alarmObjects.length; index++) {
        switch (String(alarmObjects[index].Severity)) {
            case 'Critical': counts.critical++; break;
            case 'Warning': counts.warning++; break;
            default: counts.info++;
        }
    }
    return counts;
}

// =====================================================================================
//  8. PUSH TO ZABBIX (history.push, Zabbix 7.0+)
// =====================================================================================
//  One value per device, sent to the trapper item "intersight.raw" of host
//  "intersight-<Moid>". Values for hosts not yet discovered are rejected: this is
//  expected during the first run after a new device appears.

function pushDevicesToZabbix(allDevices, collectionTime) {
    var pushResult = { enabled: CONFIG.pushEnabled ? 1 : 0, sent: 0, failed: 0 };
    var historyValues = [], index, zabbixHttp, response, perValueResults;
    var clockSeconds = Math.floor(collectionTime.getTime() / 1000);

    if (!CONFIG.pushEnabled || allDevices.length === 0) { return pushResult; }

    for (index = 0; index < allDevices.length; index++) {
        historyValues.push({
            host: ZABBIX_HOST_PREFIX + allDevices[index].moid,
            key: ZABBIX_RAW_ITEM_KEY,
            value: JSON.stringify(allDevices[index]),
            clock: clockSeconds
        });
    }

    try {
        zabbixHttp = new HttpRequest();
        zabbixHttp.addHeader('Content-Type: application/json-rpc');
        zabbixHttp.addHeader('Authorization: Bearer ' + itemParameters.zbx_token);
        response = JSON.parse(zabbixHttp.post(itemParameters.zbx_url, JSON.stringify({
            jsonrpc: '2.0', method: 'history.push', params: historyValues, id: 1
        })));
        if (response.error) { throw response.error.message + ' ' + (response.error.data || ''); }

        // The API answers with one entry per value: {itemid} on success, {error} otherwise.
        perValueResults = (response.result && response.result.data) || [];
        for (index = 0; index < perValueResults.length; index++) {
            if (perValueResults[index].error) { pushResult.failed++; } else { pushResult.sent++; }
        }
    }
    catch (error) {
        collectedErrors.push('history.push: ' + error);
        pushResult.failed = historyValues.length;
    }
    return pushResult;
}

// =====================================================================================
//  9. MAIN
// =====================================================================================

initializeAuthentication();

// --- Inventory (each endpoint is independent: one failure does not stop the others)
var serverInventory = runStepOrRecordError('servers', function () {
    return listAllObjects(INTERSIGHT_PATHS.servers);
});
var chassisInventory = runStepOrRecordError('chassis', function () {
    return listAllObjects(INTERSIGHT_PATHS.chassis);
});
var fabricInterconnectInventory = runStepOrRecordError('fabric_interconnects', function () {
    return listAllObjects(INTERSIGHT_PATHS.fabricInterconnects);
});
var openAlarms = runStepOrRecordError('alarms', function () {
    return listAllObjects(INTERSIGHT_PATHS.alarms, OPEN_ALARMS_FILTER, 'Severity');
});

// Nothing at all: fail the item, so that the "no data" trigger fires.
if (serverInventory === null && chassisInventory === null && fabricInterconnectInventory === null) {
    throw 'Intersight inventory unavailable: ' + collectedErrors.join(' | ');
}

// --- Telemetry over the last N minutes, as a Druid ISO-8601 interval "start/end"
var collectionTime = new Date();
var telemetryInterval = new Date(collectionTime.getTime() - CONFIG.telemetryWindowMinutes * 60000).toISOString() +
    '/' + collectionTime.toISOString();
var telemetryByDeviceKey = collectTelemetryByDeviceKey(telemetryInterval);

// --- Device objects
var serverDevices = buildDeviceList(serverInventory, buildServerDevice, telemetryByDeviceKey);
var chassisDevices = buildDeviceList(chassisInventory, buildChassisDevice, telemetryByDeviceKey);
var fabricInterconnectDevices = buildDeviceList(fabricInterconnectInventory, buildFabricInterconnectDevice, telemetryByDeviceKey);

assignUniqueDisplayNames(serverDevices);
assignUniqueDisplayNames(chassisDevices);
assignUniqueDisplayNames(fabricInterconnectDevices);
attachBladesToChassis(chassisDevices, serverDevices);

var allDevices = serverDevices.concat(chassisDevices, fabricInterconnectDevices);

// --- Push to the discovered hosts
var pushResult = pushDevicesToZabbix(allDevices, collectionTime);

// --- Servers listed in the parent "servers" LLD (blades excluded in 7.4 nested mode)
var serversForDiscovery = [], serverIndex;
for (serverIndex = 0; serverIndex < serverDevices.length; serverIndex++) {
    if (CONFIG.discoverBladesAsServers || serverDevices[serverIndex].is_blade === 0) {
        serversForDiscovery.push(serverDevices[serverIndex]);
    }
}

// --- Output for the parent host (LLD rules, health and aggregate items)
return JSON.stringify({
    ts: Math.floor(collectionTime.getTime() / 1000),
    api: {
        calls: apiCallCount,
        errors: collectedErrors,
        duration_ms: new Date().getTime() - runStartTime,
        sign_ms: signingTimeMs
    },
    counts: {
        servers: serverDevices.length,
        chassis: chassisDevices.length,
        fi: fabricInterconnectDevices.length
    },
    alarms: countAlarmsBySeverity(openAlarms),
    push: pushResult,
    servers: serversForDiscovery,
    chassis: chassisDevices,
    fis: fabricInterconnectDevices,
    models: listDistinctModels(allDevices)
});
