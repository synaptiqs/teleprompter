// ClickPrompt first-touch attribution.
// On the first visit this records UTM parameters, the referrer host,
// the landing path, and a timestamp in localStorage. Later visits do
// not overwrite that record, so checkout, the launch list, and future
// features (an editor, social scheduling) can all reuse the same source.
// A record expires after 90 days, and a missing, invalid, or future
// timestamp is treated as expired. An expired record is replaced by
// the current touch, or cleared if the current page has no UTM or referrer.
(function (root) {
  "use strict";

  var STORAGE_KEY = "clickprompt_attribution";
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
  var MAX_LEN = 64;
  // Discard oversized localStorage values before JSON.parse.
  var MAX_RAW_BYTES = 4096;
  // First-touch records expire at 90 days (exactly 90 days counts as expired).
  var MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

  // UTM values: lowercase letters, numbers, underscore, and hyphen only.
  function sanitizeUtm(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, MAX_LEN);
  }

  // Store only the hostname from a referrer so query tokens never land
  // in localStorage. Dots are allowed because hosts need them.
  function sanitizeReferrer(value) {
    var raw = String(value || "").trim();
    if (!raw) return "";
    var host = raw;
    try {
      if (/^https?:\/\//i.test(raw)) host = new URL(raw).hostname;
      else host = raw.split("/")[0];
    } catch (e) {
      host = raw.split("/")[0];
    }
    return host
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, "")
      .replace(/^\.+|\.+$/g, "")
      .slice(0, MAX_LEN);
  }

  // Landing path only (no query or hash). Slashes are kept.
  function sanitizeLanding(value) {
    var raw = String(value || "").trim() || "/";
    if (raw.charAt(0) !== "/") raw = "/" + raw;
    raw = raw.split("?")[0].split("#")[0];
    return raw.toLowerCase().replace(/[^a-z0-9/_-]/g, "").slice(0, MAX_LEN) || "/";
  }

  // Timestamps are ISO-8601 UTC so later features can sort or filter them.
  function sanitizeTimestamp(value) {
    var raw = String(value || "").trim().slice(0, MAX_LEN);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(raw)) return "";
    return raw;
  }

  // Build a clean record, or null if the input is not a plain object.
  function sanitizeRecord(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    var out = {};
    UTM_KEYS.forEach(function (key) {
      var value = sanitizeUtm(input[key]);
      if (value) out[key] = value;
    });
    var referrer = sanitizeReferrer(input.referrer || input.attr_referrer);
    if (referrer) out.referrer = referrer;
    var landing = sanitizeLanding(input.landing || input.landing_path || input.attr_landing || "");
    if (landing) out.landing = landing;
    var timestamp = sanitizeTimestamp(input.timestamp || input.ts || input.attr_ts);
    if (timestamp) out.timestamp = timestamp;
    return out;
  }

  // A record is worth keeping as first-touch if it has any stored field.
  function isNonEmptyRecord(record) {
    if (!record) return false;
    if (record.timestamp || record.referrer || record.landing) return true;
    for (var i = 0; i < UTM_KEYS.length; i++) {
      if (record[UTM_KEYS[i]]) return true;
    }
    return false;
  }

  // Expired when the timestamp is missing, invalid, in the future, or
  // at least 90 days old (exactly 90 days counts as expired).
  function isExpired(record) {
    if (!record) return true;
    if (!record.timestamp) return true;
    var at = Date.parse(record.timestamp);
    if (!isFinite(at)) return true;
    var now = Date.now();
    if (at > now) return true;
    return (now - at) >= MAX_AGE_MS;
  }

  function hasUtmOrReferrer(record) {
    if (!record) return false;
    if (record.referrer) return true;
    for (var i = 0; i < UTM_KEYS.length; i++) {
      if (record[UTM_KEYS[i]]) return true;
    }
    return false;
  }

  function clearStorage(storage) {
    if (!storage) return;
    try { storage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  function readStorage(storage) {
    if (!storage) return null;
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      if (String(raw).length > MAX_RAW_BYTES) {
        clearStorage(storage);
        return null;
      }
      var record = sanitizeRecord(JSON.parse(raw));
      if (!isNonEmptyRecord(record)) return null;
      if (isExpired(record)) return null;
      return record;
    } catch (e) {
      return null;
    }
  }

  // Parse a stored record without dropping it for expiry, so capture()
  // can decide whether to keep, replace, or clear it.
  function peekStorage(storage) {
    if (!storage) return null;
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      if (String(raw).length > MAX_RAW_BYTES) return null;
      return sanitizeRecord(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  }

  function writeStorage(storage, record) {
    if (!storage) return false;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(record));
      return true;
    } catch (e) {
      return false;
    }
  }

  function stampNow(record) {
    record = record || {};
    var ts = sanitizeTimestamp(new Date().toISOString());
    if (!ts) ts = new Date().toISOString().slice(0, 19) + "Z";
    record.timestamp = ts;
    return record;
  }

  // First-touch write: a non-empty, unexpired stored record always wins.
  // An expired, undated, invalid, or future record is replaced by the
  // current touch, or cleared when the current touch has no UTM or referrer.
  function capture(input, storage) {
    try {
      var existing = peekStorage(storage);
      if (isNonEmptyRecord(existing) && !isExpired(existing)) return existing;

      var record = sanitizeRecord(input) || {};
      if (existing && isExpired(existing) && !hasUtmOrReferrer(record)) {
        clearStorage(storage);
        return null;
      }

      if (!record.timestamp) stampNow(record);
      if (!writeStorage(storage, record)) return null;
      return record;
    } catch (e) {
      return null;
    }
  }

  // Read a query parameter by name, ignoring letter case (UTM_SOURCE works).
  function queryParam(params, name) {
    var want = String(name || "").toLowerCase();
    if (!params) return "";
    try {
      if (typeof params.forEach === "function") {
        var found = "";
        params.forEach(function (value, key) {
          if (!found && String(key).toLowerCase() === want) found = value;
        });
        if (found) return found;
      }
      if (typeof params.get === "function") return params.get(name) || "";
    } catch (e) {
      return "";
    }
    return "";
  }

  // All localStorage access stays inside this function. If storage is
  // blocked or throws, we return null and skip attribution.
  function captureFromPage(win, storage) {
    try {
      win = win || (typeof window !== "undefined" ? window : null);
      if (!win || !win.location) return null;
      if (!storage) {
        try { storage = win.localStorage; } catch (e) { return null; }
      }
      var params;
      try {
        params = new URLSearchParams(win.location.search);
      } catch (e) {
        params = { get: function () { return ""; } };
      }
      return capture({
        utm_source: queryParam(params, "utm_source"),
        utm_medium: queryParam(params, "utm_medium"),
        utm_campaign: queryParam(params, "utm_campaign"),
        utm_content: queryParam(params, "utm_content"),
        utm_term: queryParam(params, "utm_term"),
        referrer: win.document ? win.document.referrer : "",
        landing: win.location.pathname || "/",
        timestamp: new Date().toISOString()
      }, storage);
    } catch (e) {
      return null;
    }
  }

  // All localStorage access stays inside this function. Failures return null.
  // Expired records are cleared so checkout and signup do not send stale data.
  function get(storage) {
    try {
      if (!storage) {
        try {
          if (typeof localStorage === "undefined") return null;
          storage = localStorage;
        } catch (e) {
          return null;
        }
      }
      var existing = peekStorage(storage);
      if (existing && isExpired(existing)) {
        clearStorage(storage);
        return null;
      }
      return readStorage(storage);
    } catch (e) {
      return null;
    }
  }

  // Used by checkout and signup so a throwing store cannot break those flows.
  function attachTo(body, storage) {
    body = body || {};
    try {
      var rec = get(storage);
      if (rec) body.attribution = rec;
    } catch (e) { /* skip attribution; the caller still proceeds */ }
    return body;
  }

  // Flat string map for Lemon Squeezy checkout_data.custom (values must be strings).
  function toCheckoutCustom(record) {
    record = sanitizeRecord(record);
    if (!record) return {};
    var out = {};
    UTM_KEYS.forEach(function (key) {
      if (record[key]) out[key] = record[key];
    });
    if (record.referrer) out.attr_referrer = record.referrer;
    if (record.landing) out.attr_landing = record.landing;
    if (record.timestamp) out.attr_ts = record.timestamp;
    return out;
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    MAX_LEN: MAX_LEN,
    MAX_RAW_BYTES: MAX_RAW_BYTES,
    MAX_AGE_MS: MAX_AGE_MS,
    UTM_KEYS: UTM_KEYS,
    sanitizeUtm: sanitizeUtm,
    sanitizeReferrer: sanitizeReferrer,
    sanitizeLanding: sanitizeLanding,
    sanitizeTimestamp: sanitizeTimestamp,
    sanitizeRecord: sanitizeRecord,
    capture: capture,
    captureFromPage: captureFromPage,
    get: get,
    attachTo: attachTo,
    toCheckoutCustom: toCheckoutCustom
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.ClickPromptAttribution = api;

  // On every public page, record first-touch as soon as this file loads.
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try { captureFromPage(window); } catch (e) { /* private mode or blocked storage */ }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
