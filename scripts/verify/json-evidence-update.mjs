#!/usr/bin/env node
import fs from "node:fs";

const [file, action, key, value] = process.argv.slice(2);

if (!file || !action) {
  throw new Error("usage: json-evidence-update.mjs <file> <set|caveat|finish> ...");
}

const doc = JSON.parse(fs.readFileSync(file, "utf8"));

if (action === "set") {
  if (!key || value === undefined) {
    throw new Error("set requires <key> <json-value>");
  }
  doc.checks ??= {};
  doc.checks[key] = JSON.parse(value);
} else if (action === "caveat") {
  if (!key) {
    throw new Error("caveat requires <message>");
  }
  doc.caveats ??= [];
  doc.caveats.push(key);
} else if (action === "finish") {
  if (!key) {
    throw new Error("finish requires <status> [failure]");
  }
  doc.status = key;
  doc.finishedAt = new Date().toISOString();
  if (value) {
    doc.failure = value;
  }
} else {
  throw new Error(`unknown action: ${action}`);
}

fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
