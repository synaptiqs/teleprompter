// ClickPrompt first-touch attribution.
// On the first visit this records UTM parameters, the referrer host,
// the landing path, and a timestamp in localStorage. Later visits do
// not overwrite that record, so checkout, the launch list, and future
// features (an editor, social scheduling) can all reuse the same source.
(function (root) {
  "use strict";

  var STORAGE_KEY = "clickprompt_attribution";
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
  var MAX_LEN = 64;

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

  function readStorage(storage) {
    if (!storage) return null;
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
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

  // First-touch write: an existing stored record always wins.
  function capture(input, storage) {
    var existing = readStorage(storage);
    if (existing && existing.timestamp) return existing;
    var record = sanitizeRecord(input) || {};
    if (!record.timestamp) {
      record.timestamp = sanitizeTimestamp(new Date().toISOString().replace(/\.\d+Z$/, "Z"));
    }
    if (!record.timestamp) {
      record.timestamp = new Date().toISOString().slice(0, 19) + "Z";
    }
    writeStorage(storage, record);
    return record;
  }

  function captureFromPage(win, storage) {
    win = win || (typeof window !== "undefined" ? window : null);
    if (!win || !win.location) return null;
    storage = storage || win.localStorage;
    var params;
    try {
      params = new URLSearchParams(win.location.search);
    } catch (e) {
      params = { get: function () { return ""; } };
    }
    return capture({
      utm_source: params.get("utm_source"),
      utm_medium: params.get("utm_medium"),
      utm_campaign: params.get("utm_campaign"),
      utm_content: params.get("utm_content"),
      utm_term: params.get("utm_term"),
      referrer: win.document ? win.document.referrer : "",
      landing: win.location.pathname || "/",
      timestamp: new Date().toISOString()
    }, storage);
  }

  function get(storage) {
    if (!storage && typeof localStorage !== "undefined") storage = localStorage;
    return readStorage(storage);
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
    UTM_KEYS: UTM_KEYS,
    sanitizeUtm: sanitizeUtm,
    sanitizeReferrer: sanitizeReferrer,
    sanitizeLanding: sanitizeLanding,
    sanitizeTimestamp: sanitizeTimestamp,
    sanitizeRecord: sanitizeRecord,
    capture: capture,
    captureFromPage: captureFromPage,
    get: get,
    toCheckoutCustom: toCheckoutCustom
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.ClickPromptAttribution = api;

  // On every public page, record first-touch as soon as this file loads.
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try { captureFromPage(window, window.localStorage); } catch (e) { /* private mode or blocked storage */ }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
