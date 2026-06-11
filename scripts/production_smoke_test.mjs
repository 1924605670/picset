#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_BASE_PATH = "/picset";
const DEFAULT_PROJECT_ID = "project_default";
const DEFAULT_ADMIN_USER_ID = "user_system_admin";
const SESSION_COOKIE_NAME = "picset_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function parseEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function normalizeBasePath(path) {
  const raw = String(path || "").trim();
  if (!raw || raw === "/") return "";
  return `/${raw.replace(/^\/+|\/+$/g, "")}`;
}

function storageId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function decodePrompt() {
  if (process.env.PICSET_SMOKE_PROMPT_B64) {
    return Buffer.from(process.env.PICSET_SMOKE_PROMPT_B64, "base64").toString("utf8");
  }
  return process.env.PICSET_SMOKE_PROMPT || [
    "一张横版 4K 电影感动漫场景：",
    "一只橘猫和一只白色小狗在明亮厨房里进行搞笑料理比赛，",
    "面粉飞在空中，番茄滚落，表情夸张但可爱，",
    "高细节，干净构图，温暖日光，适合动画剧集封面，不要文字、水印或标志。",
  ].join("");
}

function log(message, extra = {}) {
  const suffix = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[picset-smoke] ${message}${suffix}`);
}

function parseImageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: "png" };
  }

  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < buffer.length) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), type: "jpeg" };
      }
      offset += 2 + length;
    }
  }

  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height, type: "webp" };
    }
  }

  return { width: 0, height: 0, type: "unknown" };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readJson(res, fallback) {
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw: raw.slice(0, 500) };
  }
  if (!res.ok) {
    const message = data.error || data.message || raw.slice(0, 500) || fallback;
    throw new Error(`${fallback}: HTTP ${res.status} ${message}`);
  }
  return data;
}

function ensureSmokeIdentity(db, email) {
  const ts = Date.now();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  const userId = existing?.id || "user_picset_smoke";
  const username = "picset_smoke";

  if (existing?.id) {
    db.prepare(`
      UPDATE users
      SET username = ?, role = 'member', status = 'active', display_name = ?, updated_at = ?
      WHERE id = ?
    `).run(username, "PicSet Smoke Test", ts, existing.id);
  } else {
    const byId = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
    if (byId?.id) {
      db.prepare(`
        UPDATE users
        SET username = ?, email = ?, role = 'member', status = 'active', display_name = ?, updated_at = ?
        WHERE id = ?
      `).run(username, email, "PicSet Smoke Test", ts, userId);
    } else {
      db.prepare(`
        INSERT INTO users (id, username, email, password_hash, role, status, display_name, created_at, updated_at, last_login_at)
        VALUES (?, ?, ?, NULL, 'member', 'active', ?, ?, ?, NULL)
      `).run(userId, username, email, "PicSet Smoke Test", ts, ts);
    }
  }

  const projectJson = JSON.stringify({
    id: DEFAULT_PROJECT_ID,
    name: "默认项目",
    description: "生产烟测默认工作区",
    ownerId: DEFAULT_ADMIN_USER_ID,
    createdAt: ts,
    updatedAt: ts,
  });
  db.prepare(`
    INSERT INTO records (store, id, project_id, owner_id, json, created_at, updated_at, deleted_at)
    VALUES ('projects', ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(store, id) DO NOTHING
  `).run(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID, DEFAULT_ADMIN_USER_ID, projectJson, ts, ts);

  db.prepare(`
    INSERT INTO project_members (project_id, user_id, role, created_at, updated_at)
    VALUES (?, ?, 'member', ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET role = 'member', updated_at = excluded.updated_at
  `).run(DEFAULT_PROJECT_ID, userId, ts, ts);

  db.prepare(`
    INSERT INTO user_quotas (user_id, quota_total, quota_used, created_at, updated_at, updated_by)
    VALUES (?, -1, 0, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET quota_total = -1, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(userId, ts, ts, DEFAULT_ADMIN_USER_ID);

  db.prepare("UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(ts, ts, userId);
  const token = randomBytes(32).toString("base64url");
  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, updated_at, user_agent, ip, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, 'picset-production-smoke/1.0', '127.0.0.1', NULL)
  `).run(storageId("sess"), userId, hashToken(token), ts + SESSION_TTL_MS, ts, ts);

  return { userId, token };
}

function resolveImagePath(generatedDir, output) {
  if (output?.path) return resolve(generatedDir, String(output.path).replace(/^\/+/, ""));
  const image = String(output?.imageUrl || output?.image || "");
  const match = image.match(/api\/generated\/(.+)$/);
  if (!match) return "";
  return resolve(generatedDir, decodeURIComponent(match[1]));
}

async function main() {
  const envFile = process.env.PICSET_ENV_FILE || "/etc/picset.env";
  const cfg = { ...parseEnvFile(envFile), ...parseEnvFile(join(process.cwd(), ".env")), ...process.env };
  const dataDir = resolve(cfg.PICSET_DATA_DIR || "/opt/picset/data");
  const generatedDir = resolve(cfg.PICSET_GENERATED_DIR || join(dataDir, "generated"));
  const dbFile = resolve(cfg.PICSET_DB_FILE || join(dataDir, "picset.sqlite"));
  const basePath = normalizeBasePath(cfg.PICSET_BASE_PATH || DEFAULT_BASE_PATH);
  const port = Number(cfg.PORT || cfg.APP_PORT || 4173);
  const origin = String(cfg.PICSET_SMOKE_ORIGIN || `http://127.0.0.1:${port}${basePath}`).replace(/\/+$/, "");
  const email = cfg.PICSET_SMOKE_EMAIL || "picset-smoke@hometodo.top";
  const size = cfg.PICSET_SMOKE_SIZE || "3840x2160";
  const quality = cfg.PICSET_SMOKE_QUALITY || "high";
  const format = cfg.PICSET_SMOKE_FORMAT || "png";
  const timeoutMs = Number(cfg.PICSET_SMOKE_TIMEOUT_MS || 25 * 60 * 1000);
  const prompt = decodePrompt();

  log("starting", { origin, dbFile: basename(dbFile), email, size, quality, format, timeoutMs });
  if (!existsSync(dbFile)) throw new Error(`SQLite database not found: ${dbFile}`);

  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
  const { userId, token } = ensureSmokeIdentity(db, email);
  db.close();
  const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
  log("session prepared", { userId });

  const me = await readJson(await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } }), "auth check failed");
  if (!me.authenticated) throw new Error("smoke session was not authenticated");
  log("auth ok", { user: me.user?.email, quota: me.user?.quota });

  const createPayload = {
    projectId: DEFAULT_PROJECT_ID,
    messageId: storageId("smoke_msg"),
    prompt,
    size,
    quality,
    format,
    reasoning: "off",
    images: [],
  };
  const created = await readJson(await fetch(`${origin}/api/generation-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(createPayload),
  }), "create generation task failed");
  const taskId = created.task?.id;
  if (!taskId) throw new Error("generation task id missing");
  log("task created", { taskId, status: created.task.status, progress: created.task.progress });

  const started = Date.now();
  let task = created.task;
  let lastProgress = -1;
  let lastLabel = "";
  while (Date.now() - started < timeoutMs) {
    const data = await readJson(await fetch(`${origin}/api/generation-tasks/${encodeURIComponent(taskId)}`, {
      headers: { Cookie: cookie },
    }), "poll generation task failed");
    task = data.task;
    const label = task.output?.label || task.output?.logs?.at?.(-1) || "";
    if (task.progress !== lastProgress || label !== lastLabel || ["failed", "cancelled", "succeeded"].includes(task.status)) {
      log("task progress", { taskId, status: task.status, progress: task.progress, label });
      lastProgress = task.progress;
      lastLabel = label;
    }
    if (task.status === "succeeded") break;
    if (task.status === "failed" || task.status === "cancelled") {
      throw new Error(`generation ${task.status}: ${task.error || task.output?.error || "unknown error"}`);
    }
    await sleep(5000);
  }

  if (task.status !== "succeeded") {
    throw new Error(`generation timed out after ${timeoutMs}ms; last status=${task.status} progress=${task.progress}`);
  }

  const imageRef = task.output?.imageUrl || task.output?.image || "";
  if (!imageRef) throw new Error("generation succeeded without image reference");
  const publicImageUrl = /^https?:\/\//i.test(imageRef) ? imageRef : `${origin}/${String(imageRef).replace(/^\/+/, "")}`;
  const head = await fetch(publicImageUrl, { method: "HEAD", headers: { Cookie: cookie } });
  if (!head.ok) throw new Error(`generated image HEAD failed: HTTP ${head.status}`);

  const filePath = resolveImagePath(generatedDir, task.output);
  if (!filePath || !existsSync(filePath)) {
    throw new Error(`generated image file not found: ${filePath || "(unknown)"}`);
  }
  const buffer = readFileSync(filePath);
  const dimensions = parseImageDimensions(buffer);
  const bytes = statSync(filePath).size;
  log("image verified", { publicImageUrl, filePath, bytes, ...dimensions, elapsedMs: Date.now() - started });
  if (size === "3840x2160" && (dimensions.width !== 3840 || dimensions.height !== 2160)) {
    throw new Error(`expected 3840x2160, got ${dimensions.width}x${dimensions.height}`);
  }
  if (size === "2160x3840" && (dimensions.width !== 2160 || dimensions.height !== 3840)) {
    throw new Error(`expected 2160x3840, got ${dimensions.width}x${dimensions.height}`);
  }
}

main().catch((error) => {
  console.error(`[picset-smoke] failed ${error?.stack || error?.message || error}`);
  process.exit(1);
});
