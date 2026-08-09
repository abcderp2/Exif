"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");

assert.match(html, /http-equiv=["']Content-Security-Policy["']/i);
assert.match(html, /connect-src 'none'/);
assert.match(html, /object-src 'none'/);
assert.match(html, /form-action 'none'/);
assert.doesNotMatch(html, /http-equiv=["']Permissions-Policy["']/i);
assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i);
assert.doesNotMatch(html, /<link[^>]+href=["']https?:\/\/[^"']+\.css/i);

console.log("static security checks passed");
