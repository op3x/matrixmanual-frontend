// First-party campaign tags for checkout. No cookies and no network calls.
// localStorage key mos_attr keeps the first touch for 90 days.
// A later URL with utm_* params also stores that visit under latest.
// Click ids alone do not replace an existing record.
(function () {
  var KEY = 'mos_attr';
  var MAX = 100;
  var MAX_AGE = 90 * 24 * 60 * 60 * 1000;
  var FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'msclkid'];
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var TOUCH_KEYS = ['first_seen_at', 'landing_path', 'referrer_host'].concat(FIELDS);
  var CLICK_IDS = { gclid: true, msclkid: true };
  var CLICK_MAX = 500;
  // Opaque click ids. Letters, digits, underscore, and hyphen only.
  var CLICK_CHARS = /^[A-Za-z0-9_-]+$/;
  var EMAIL_LIKE = /[^\s@]+@[^\s@]+/;

  function stripControls(value) {
    return String(value).replace(/\p{Cc}/gu, '');
  }

  function trim(value) {
    return value.replace(/^\s+|\s+$/g, '');
  }

  function capLength(value, max) {
    if (value.length <= max) return value;
    var end = max;
    var tail = value.charCodeAt(end - 1);
    if (tail >= 0xD800 && tail <= 0xDBFF) end -= 1;
    return end > 0 ? value.slice(0, end) : '';
  }

  function decodeOnce(value) {
    if (value.indexOf('%') === -1) return '';
    try {
      var decoded = decodeURIComponent(value);
      return decoded === value ? '' : decoded;
    } catch (err) {
      return '';
    }
  }

  function looksLikeEmail(value) {
    var normalized = value.normalize('NFKC');
    if (EMAIL_LIKE.test(normalized)) return true;
    var decoded = decodeOnce(normalized);
    return Boolean(decoded && EMAIL_LIKE.test(decoded.normalize('NFKC')));
  }

  // Same digit rule as the checkout service: NFKC, drop separators, then any
  // run of 9 or more digits. The stored text itself is not rewritten.
  function hasLongDigitRun(value) {
    var compact = value.normalize('NFKC').replace(/[\s().+\-]/g, '');
    if (/\d{9,}/.test(compact)) return true;
    var decoded = decodeOnce(value);
    if (!decoded) return false;
    return /\d{9,}/.test(decoded.normalize('NFKC').replace(/[\s().+\-]/g, ''));
  }

  function cleanValue(key, value) {
    try {
      if (value == null) return '';
      var text = trim(stripControls(value));
      if (!text) return '';
      if (CLICK_IDS[key]) {
        if (!CLICK_CHARS.test(text)) return '';
        return capLength(text, CLICK_MAX);
      }
      if (looksLikeEmail(text) || hasLongDigitRun(text)) return '';
      text = capLength(text, MAX);
      if (!text || looksLikeEmail(text) || hasLongDigitRun(text)) return '';
      return text;
    } catch (err) {
      return '';
    }
  }

  function hasNamed(obj, names) {
    for (var i = 0; i < names.length; i++) {
      if (obj && obj[names[i]]) return true;
    }
    return false;
  }

  function paramsFrom(search) {
    var out = {};
    try {
      var qs = new URLSearchParams(search || '');
      for (var i = 0; i < FIELDS.length; i++) {
        var value = cleanValue(FIELDS[i], qs.get(FIELDS[i]));
        if (value) out[FIELDS[i]] = value;
      }
    } catch (err) {}
    return out;
  }

  function landingPath() {
    try {
      var path = cleanValue('landing_path', location.pathname || '/');
      if (!path || path.charAt(0) !== '/') return '/';
      return path;
    } catch (err) {
      return '/';
    }
  }

  function externalHost() {
    try {
      var referrer = document.referrer;
      if (!referrer) return '';
      var host = new URL(referrer).hostname;
      if (!host) return '';
      var here = String(location.hostname || '').toLowerCase();
      var there = String(host).toLowerCase();
      if (!there || there === here) return '';
      if (here && (there === 'www.' + here || here === 'www.' + there)) return '';
      return cleanValue('referrer_host', host);
    } catch (err) {
      return '';
    }
  }

  function copyTouch(target, source, keys) {
    for (var i = 0; i < keys.length; i++) {
      var raw = source && typeof source[keys[i]] === 'string' ? source[keys[i]] : '';
      var value = cleanValue(keys[i], raw);
      if (value) target[keys[i]] = value;
    }
  }

  function buildTouch(params, seenAt) {
    var touch = { first_seen_at: seenAt, landing_path: landingPath() };
    var host = externalHost();
    if (host) touch.referrer_host = host;
    copyTouch(touch, params, FIELDS);
    return touch;
  }

  function storageGet() {
    try {
      return localStorage.getItem(KEY);
    } catch (err) {
      return null;
    }
  }

  function storageSet(value) {
    try {
      localStorage.setItem(KEY, value);
      return true;
    } catch (err) {
      return false;
    }
  }

  function storageClear() {
    try {
      localStorage.removeItem(KEY);
    } catch (err) {}
  }

  function readRaw() {
    var raw = storageGet();
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        storageClear();
        return null;
      }
      return data;
    } catch (err) {
      storageClear();
      return null;
    }
  }

  function fresh(data) {
    // The 90-day limit belongs to the first visit. A latest touch does not get
    // its own lifetime: when the first touch expires, latest is deleted with it.
    if (!data || typeof data.first_seen_at !== 'string') return false;
    var seen = Date.parse(data.first_seen_at);
    if (!isFinite(seen)) return false;
    return (Date.now() - seen) < MAX_AGE;
  }

  function sanitize(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    var out = {};
    copyTouch(out, data, TOUCH_KEYS);
    if (!out.first_seen_at) return null;
    if (!out.landing_path) out.landing_path = '/';
    if (data.latest && typeof data.latest === 'object' && !Array.isArray(data.latest)) {
      var latest = {};
      copyTouch(latest, data.latest, TOUCH_KEYS);
      if (latest.first_seen_at) out.latest = latest;
    }
    return out;
  }

  function writeRecord(data) {
    var clean = sanitize(data);
    if (!clean) return;
    storageSet(JSON.stringify(clean));
  }

  function capture() {
    try {
      var params = paramsFrom(location.search);
      var existing = readRaw();
      if (existing && !fresh(existing)) {
        storageClear();
        existing = null;
      }
      if (!existing) {
        if (!hasNamed(params, FIELDS)) return;
        writeRecord(buildTouch(params, new Date().toISOString()));
        return;
      }
      if (!hasNamed(params, UTM)) return;
      var record = sanitize(existing);
      if (!record) {
        writeRecord(buildTouch(params, new Date().toISOString()));
        return;
      }
      record.latest = buildTouch(params, new Date().toISOString());
      writeRecord(record);
    } catch (err) {}
  }

  function mosReadAttribution() {
    try {
      var data = readRaw();
      if (!data || !fresh(data)) {
        if (data) storageClear();
        return null;
      }
      return sanitize(data);
    } catch (err) {
      return null;
    }
  }

  try {
    window.mosReadAttribution = mosReadAttribution;
  } catch (err) {}
  capture();
})();
