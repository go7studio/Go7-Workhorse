#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-sqlite-probe-"));
const dbPath = path.join(dir, "learning", "learning.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
const version = db.prepare("select sqlite_version() as v").get().v;
db.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
db.exec("INSERT INTO t VALUES ('prefer conventional commits')");
const hit = db.prepare("SELECT x FROM t WHERE t MATCH 'conventional'").get();
db.close();
if (!hit || hit.x !== "prefer conventional commits") {
  console.error("FTS5 probe failed");
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, sqliteVersion: version, fts5: true, path: dbPath }, null, 2));
