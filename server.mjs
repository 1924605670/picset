import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomInt, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const rootDir = resolve(import.meta.dirname);
const publicDir = join(rootDir, "public");
const workspaceDir = resolve(rootDir, "..");
const skillEnvFile = "/Users/chengzhihua/.codex/skills/vsllm-image/.env";
const defaultPort = Number(process.env.PORT || 4173);
const dataDir = resolve(process.env.PICSET_DATA_DIR || join(rootDir, "data"));
const dbFile = resolve(process.env.PICSET_DB_FILE || join(dataDir, "picset.sqlite"));
const generatedDir = resolve(process.env.PICSET_GENERATED_DIR || join(dataDir, "generated"));

const DEFAULT_API_BASE = "https://vsllm.com/v1";
const DEFAULT_IMAGE_MODEL = "gpt-image-2-chat";
const DEFAULT_TOOL_MODEL = "gpt-image-2";
const DEFAULT_ENHANCE_MODEL = "deepseek-v4-pro";
const DEFAULT_PROJECT_ID = "project_default";
const DEFAULT_ADMIN_USER_ID = "user_system_admin";
const DEFAULT_ADMIN_EMAIL = "admin@picset.local";
const DEFAULT_ADMIN_USERNAME = "admin";
const SESSION_COOKIE_NAME = "picset_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;
const VERIFICATION_MAX_ATTEMPTS = 5;
const VERIFICATION_EMAIL_HOURLY_LIMIT = 5;
const VERIFICATION_IP_HOURLY_LIMIT = 20;
const DEFAULT_FREE_GENERATION_CREDITS = 10;
const UNLIMITED_QUOTA = -1;
const DEFAULT_BASE_PATH = "/picset";
const DATA_STORES = new Set(["projects", "conversations", "messages", "gallery", "galleryFolders", "favorites", "assets"]);
const IMAGE_MODEL_OPTIONS = [
  { id: DEFAULT_IMAGE_MODEL, name: "标准生成", desc: "默认通道 · 适合日常草稿", premium: false },
];
const ENHANCE_MODEL_OPTIONS = [
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", desc: "当前默认 · 适合中文提示词优化和剧情拆帧" },
  { id: "MiniMax-M3", name: "MiniMax-M3", desc: "备选 LLM · 适合长文本规划和中文创作" },
];

mkdirSync(dataDir, { recursive: true });
mkdirSync(generatedDir, { recursive: true });
const db = new DatabaseSync(dbFile);
const generationWorkers = new Map();

class HttpError extends Error {
  constructor(status, message, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function nowMs() {
  return Date.now();
}

function storageId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumnIfMissing(table, column, definition) {
  if (tableColumns(table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const key = scryptSync(String(password), salt, 64).toString("base64url");
  return `scrypt$${salt}$${key}`;
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function writeAuditLog(action, entityType, entityId = "", projectId = "", detail = {}, actorId = DEFAULT_ADMIN_USER_ID) {
  const ts = nowMs();
  db.prepare(`
    INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, project_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    storageId("audit"),
    actorId || null,
    action,
    entityType,
    entityId || null,
    projectId || null,
    JSON.stringify(detail || {}),
    ts,
  );
}

function ensureProjectMember(projectId, userId = DEFAULT_ADMIN_USER_ID, role = "owner") {
  if (!projectId || !userId) return;
  const ts = nowMs();
  db.prepare(`
    INSERT INTO project_members (project_id, user_id, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET
      role = CASE
        WHEN project_members.role = 'owner' THEN project_members.role
        ELSE excluded.role
      END,
      updated_at = excluded.updated_at
  `).run(projectId, userId, role, ts, ts);
}

function seedDefaultAdmin() {
  const existing = db.prepare("SELECT id, password_hash FROM users WHERE id = ?").get(DEFAULT_ADMIN_USER_ID);
  const config = loadConfig();
  const username = pick(config, ["PICSET_ADMIN_USERNAME"], DEFAULT_ADMIN_USERNAME);
  const email = pick(config, ["PICSET_ADMIN_EMAIL"], DEFAULT_ADMIN_EMAIL);
  const displayName = pick(config, ["PICSET_ADMIN_DISPLAY_NAME"], "系统管理员");
  const password = pick(config, ["PICSET_ADMIN_PASSWORD"], "");
  const passwordHash = password ? hashPassword(password) : null;
  const status = passwordHash ? "active" : "setup_required";
  const ts = nowMs();

  if (!existing) {
    db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role, status, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?)
    `).run(DEFAULT_ADMIN_USER_ID, username, email, passwordHash, status, displayName, ts, ts);
    writeAuditLog("user.seeded", "user", DEFAULT_ADMIN_USER_ID, "", { username, status }, DEFAULT_ADMIN_USER_ID);
    return;
  }

  if (!existing.password_hash && passwordHash) {
    db.prepare(`
      UPDATE users
      SET username = ?, email = ?, password_hash = ?, status = 'active', display_name = ?, updated_at = ?
      WHERE id = ?
    `).run(username, email, passwordHash, displayName, ts, DEFAULT_ADMIN_USER_ID);
    writeAuditLog("user.activated", "user", DEFAULT_ADMIN_USER_ID, "", { username }, DEFAULT_ADMIN_USER_ID);
  }
}

function migrateRecordOwnership() {
  const ts = nowMs();
  const rows = db.prepare("SELECT store, id, project_id, json, owner_id, deleted_at FROM records").all();
  const update = db.prepare(`
    UPDATE records
    SET project_id = ?, owner_id = ?, deleted_at = ?, json = ?, updated_at = ?
    WHERE store = ? AND id = ?
  `);

  for (const row of rows) {
    const record = parseRecord(row) || {};
    const projectId = row.store === "projects"
      ? row.id
      : String(record.projectId || row.project_id || DEFAULT_PROJECT_ID);
    const ownerId = String(record.ownerId || row.owner_id || DEFAULT_ADMIN_USER_ID);
    const deletedAt = Number(record.deletedAt || row.deleted_at || 0);
    const next = row.store === "projects"
      ? { ...record, id: row.id, ownerId, createdAt: record.createdAt || ts, updatedAt: record.updatedAt || ts }
      : { ...record, id: row.id, projectId, ownerId, createdAt: record.createdAt || ts, updatedAt: record.updatedAt || ts };

    update.run(projectId, ownerId, deletedAt, JSON.stringify(next), Number(next.updatedAt || ts), row.store, row.id);
    if (row.store === "projects") ensureProjectMember(row.id, ownerId, "owner");
  }
}

function initializeStorage() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS records (
      store TEXT NOT NULL,
      id TEXT NOT NULL,
      project_id TEXT,
      owner_id TEXT,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (store, id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
      status TEXT NOT NULL CHECK(status IN ('active', 'disabled', 'setup_required')),
      display_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      user_agent TEXT,
      ip TEXT,
      revoked_at INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      project_id TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS generation_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('register', 'login')),
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      consumed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id TEXT PRIMARY KEY,
      quota_total INTEGER NOT NULL DEFAULT 10,
      quota_used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      message_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      cost INTEGER NOT NULL DEFAULT 1,
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_project ON generation_tasks(project_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email, purpose, created_at);
    CREATE INDEX IF NOT EXISTS idx_email_verifications_ip ON email_verifications(ip, sent_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_user ON usage_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_status ON usage_events(status, created_at);
  `);

  addColumnIfMissing("records", "owner_id", "TEXT");
  addColumnIfMissing("records", "deleted_at", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("generation_tasks", "usage_event_id", "TEXT");
  addColumnIfMissing("generation_tasks", "cancel_requested", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_records_store_project ON records(store, project_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_records_owner_store ON records(owner_id, store, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_records_updated ON records(store, updated_at);
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_owner ON generation_tasks(owner_id, status, updated_at);
  `);
  seedDefaultAdmin();
  ensureQuotasForExistingUsers();
  migrateRecordOwnership();
  ensureDefaultProject();
}

function parseRecord(row) {
  try {
    return JSON.parse(row.json);
  } catch {
    return null;
  }
}

function getUserById(userId) {
  if (!userId) return null;
  return db.prepare(`
    SELECT
      id,
      username,
      email,
      role,
      status,
      display_name AS displayName,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_login_at AS lastLoginAt
    FROM users
    WHERE id = ?
  `).get(userId) || null;
}

function defaultActor() {
  return getUserById(DEFAULT_ADMIN_USER_ID) || {
    id: DEFAULT_ADMIN_USER_ID,
    username: DEFAULT_ADMIN_USERNAME,
    email: DEFAULT_ADMIN_EMAIL,
    role: "owner",
    status: "setup_required",
    displayName: "系统管理员",
  };
}

function actorOrDefault(actor) {
  return actor?.id ? actor : defaultActor();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    status: user.status,
    displayName: user.displayName || user.display_name || user.username,
    quota: quotaSummaryForUser(user),
  };
}

function isGlobalAdmin(user) {
  return user?.role === "owner" || user?.role === "admin";
}

function projectMemberRole(projectId, userId) {
  if (!projectId || !userId) return "";
  return db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
    .get(projectId, userId)?.role || "";
}

function canAccessProject(user, projectId) {
  if (!user?.id || !projectId) return false;
  if (isGlobalAdmin(user)) return true;
  return Boolean(projectMemberRole(projectId, user.id));
}

function assertProjectAccess(user, projectId) {
  if (canAccessProject(user, projectId)) return;
  throw new HttpError(403, "没有这个项目的访问权限", "project_forbidden");
}

function activeHumanUserCount() {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE status = 'active' AND id != ?
  `).get(DEFAULT_ADMIN_USER_ID)?.count || 0);
}

function defaultFreeGenerationCredits() {
  const raw = Number(pick(loadConfig(), ["PICSET_FREE_GENERATIONS", "PICSET_FREE_CREDITS"], String(DEFAULT_FREE_GENERATION_CREDITS)));
  if (!Number.isFinite(raw)) return DEFAULT_FREE_GENERATION_CREDITS;
  return Math.max(0, Math.floor(raw));
}

function defaultQuotaTotalForUser(user) {
  if (user?.id === DEFAULT_ADMIN_USER_ID) return UNLIMITED_QUOTA;
  return defaultFreeGenerationCredits();
}

function quotaRowForUser(userId) {
  if (!userId) return null;
  return db.prepare(`
    SELECT
      user_id AS userId,
      quota_total AS quotaTotal,
      quota_used AS quotaUsed,
      created_at AS createdAt,
      updated_at AS updatedAt,
      updated_by AS updatedBy
    FROM user_quotas
    WHERE user_id = ?
  `).get(userId) || null;
}

function ensureQuotaForUser(userOrId) {
  const user = typeof userOrId === "string"
    ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(userOrId)
    : userOrId;
  if (!user?.id) return null;
  const existing = quotaRowForUser(user.id);
  if (existing) return existing;
  const ts = nowMs();
  db.prepare(`
    INSERT INTO user_quotas (user_id, quota_total, quota_used, created_at, updated_at, updated_by)
    VALUES (?, ?, 0, ?, ?, ?)
  `).run(user.id, defaultQuotaTotalForUser(user), ts, ts, DEFAULT_ADMIN_USER_ID);
  return quotaRowForUser(user.id);
}

function ensureQuotasForExistingUsers() {
  const users = db.prepare("SELECT id, role FROM users").all();
  for (const user of users) ensureQuotaForUser(user);
}

function quotaSummaryForUser(userOrId) {
  const userId = typeof userOrId === "string" ? userOrId : userOrId?.id;
  if (!userId) return null;
  const row = ensureQuotaForUser(userOrId);
  if (!row) return null;
  const total = Number(row.quotaTotal ?? 0);
  const used = Math.max(0, Number(row.quotaUsed || 0));
  const unlimited = total < 0;
  return {
    total,
    used,
    remaining: unlimited ? null : Math.max(0, total - used),
    unlimited,
  };
}

function reserveGenerationCredit(user, input = {}) {
  const actor = actorOrDefault(user);
  ensureQuotaForUser(actor);
  const before = quotaRowForUser(actor.id);
  if (!before) throw new HttpError(500, "用户额度初始化失败", "quota_missing");
  if (Number(before.quotaTotal) >= 0 && Number(before.quotaUsed) >= Number(before.quotaTotal)) {
    throw new HttpError(402, "免费生成次数已用完，请联系管理员增加次数", "quota_exceeded");
  }
  const ts = nowMs();
  const updated = db.prepare(`
    UPDATE user_quotas
    SET quota_used = quota_used + 1,
      updated_at = ?
    WHERE user_id = ?
      AND (quota_total < 0 OR quota_used < quota_total)
  `).run(ts, actor.id);
  if (!updated?.changes) {
    throw new HttpError(402, "免费生成次数已用完，请联系管理员增加次数", "quota_exceeded");
  }
  const eventId = storageId("usage");
  const inputJson = JSON.stringify({
    prompt: String(input.prompt || "").slice(0, 3000),
    imageCount: Array.isArray(input.images) ? input.images.length : 0,
    size: input.size || "auto",
    quality: input.quality || "high",
    format: input.format || "png",
    seed: input.seed || 0,
  });
  db.prepare(`
    INSERT INTO usage_events (id, user_id, project_id, message_id, kind, status, cost, input_json, output_json, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'image_generation', 'reserved', 1, ?, '{}', NULL, ?, ?)
  `).run(
    eventId,
    actor.id,
    String(input.projectId || ""),
    String(input.messageId || ""),
    inputJson,
    ts,
    ts,
  );
  return {
    id: eventId,
    userId: actor.id,
    settled: false,
    quota: quotaSummaryForUser(actor),
  };
}

function refundGenerationCredit(reservation, error = "") {
  if (!reservation || reservation.settled) return quotaSummaryForUser(reservation?.userId || "");
  reservation.settled = true;
  const ts = nowMs();
  const usage = db.prepare(`
    UPDATE usage_events
    SET status = 'refunded',
      error = ?,
      updated_at = ?
    WHERE id = ? AND status = 'reserved'
  `).run(String(error || "").slice(0, 1200), ts, reservation.id);
  if (usage?.changes) {
    db.prepare(`
      UPDATE user_quotas
      SET quota_used = CASE WHEN quota_used > 0 THEN quota_used - 1 ELSE 0 END,
        updated_at = ?
      WHERE user_id = ?
    `).run(ts, reservation.userId);
  }
  return quotaSummaryForUser(reservation.userId);
}

function commitGenerationCredit(reservation, output = {}) {
  if (!reservation || reservation.settled) return quotaSummaryForUser(reservation?.userId || "");
  reservation.settled = true;
  const ts = nowMs();
  db.prepare(`
    UPDATE usage_events
    SET status = 'succeeded',
      output_json = ?,
      updated_at = ?
    WHERE id = ? AND status = 'reserved'
  `).run(JSON.stringify(output || {}), ts, reservation.id);
  return quotaSummaryForUser(reservation.userId);
}

function getActiveRecordRow(store, id) {
  return db.prepare("SELECT * FROM records WHERE store = ? AND id = ? AND deleted_at = 0").get(store, id) || null;
}

function getRecord(store, id) {
  const row = db.prepare("SELECT json FROM records WHERE store = ? AND id = ? AND deleted_at = 0").get(store, id);
  return row ? parseRecord(row) : null;
}

function putRecord(store, record, actor = null) {
  if (!DATA_STORES.has(store)) throw new Error(`unsupported store: ${store}`);
  if (!record || typeof record !== "object") throw new Error("record must be an object");
  const user = actorOrDefault(actor);
  const id = String(record.id || "").trim();
  if (!id) throw new Error("record.id is required");
  const createdAt = Number(record.createdAt || nowMs());
  const updatedAt = Number(record.updatedAt || record.createdAt || nowMs());
  const existing = getActiveRecordRow(store, id);
  const projectId = store === "projects" ? id : String(record.projectId || DEFAULT_PROJECT_ID);
  if (existing) assertProjectAccess(user, store === "projects" ? id : projectId);
  if (store !== "projects") assertProjectAccess(user, projectId);
  const ownerId = String(existing?.owner_id || user.id || DEFAULT_ADMIN_USER_ID);
  const deletedAt = Number(record.deletedAt || 0);
  const next = store === "projects"
    ? { ...record, id, ownerId, createdAt, updatedAt }
    : { ...record, id, projectId, ownerId, createdAt, updatedAt };
  db.prepare(`
    INSERT INTO records (store, id, project_id, owner_id, json, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(store, id) DO UPDATE SET
      project_id = excluded.project_id,
      owner_id = excluded.owner_id,
      json = excluded.json,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at
  `).run(store, id, projectId, ownerId, JSON.stringify(next), createdAt, updatedAt, deletedAt);
  if (store === "projects" && !existing) ensureProjectMember(id, user.id, "owner");
  writeAuditLog("record.upserted", store, id, projectId, { ownerId }, user.id);
  return next;
}

function ensureDefaultProject() {
  if (getRecord("projects", DEFAULT_PROJECT_ID)) return;
  const ts = Date.now();
  putRecord("projects", {
    id: DEFAULT_PROJECT_ID,
    name: "默认项目",
    description: "迁移和新建内容的默认工作区",
    createdAt: ts,
    updatedAt: ts,
  });
}

function ensureUserProject(user) {
  const actor = actorOrDefault(user);
  ensureDefaultProject();
  if (isGlobalAdmin(actor)) return DEFAULT_PROJECT_ID;
  const existing = db.prepare(`
    SELECT pm.project_id AS projectId
    FROM project_members pm
    JOIN records r ON r.store = 'projects' AND r.id = pm.project_id AND r.deleted_at = 0
    WHERE pm.user_id = ?
    ORDER BY r.updated_at DESC, r.created_at DESC
    LIMIT 1
  `).get(actor.id);
  if (existing?.projectId) return existing.projectId;
  const ts = nowMs();
  const project = putRecord("projects", {
    id: storageId("project"),
    name: "我的项目",
    description: "邮箱注册后自动创建的个人工作区",
    createdAt: ts,
    updatedAt: ts,
  }, actor);
  return project.id;
}

function resolveProjectIdForUser(user, requestedProjectId = "") {
  const actor = actorOrDefault(user);
  ensureUserProject(actor);
  const requested = String(requestedProjectId || "").trim();
  if (requested && getRecord("projects", requested) && canAccessProject(actor, requested)) return requested;
  const first = listRecords("projects", "", actor)[0];
  return first?.id || ensureUserProject(actor);
}

function listRecords(store, projectId = "", actor = null) {
  if (!DATA_STORES.has(store)) throw new Error(`unsupported store: ${store}`);
  const user = actorOrDefault(actor);
  let rows = [];
  if (store === "projects") {
    rows = isGlobalAdmin(user)
      ? db.prepare("SELECT json FROM records WHERE store = 'projects' AND deleted_at = 0 ORDER BY updated_at DESC, created_at DESC").all()
      : db.prepare(`
          SELECT r.json
          FROM records r
          JOIN project_members pm ON pm.project_id = r.id AND pm.user_id = ?
          WHERE r.store = 'projects' AND r.deleted_at = 0
          ORDER BY r.updated_at DESC, r.created_at DESC
        `).all(user.id);
    return rows.map(parseRecord).filter(Boolean);
  }
  const requested = String(projectId || "").trim();
  if (requested) {
    assertProjectAccess(user, requested);
    rows = db.prepare("SELECT json FROM records WHERE store = ? AND project_id = ? AND deleted_at = 0 ORDER BY updated_at DESC, created_at DESC").all(store, requested);
  } else if (isGlobalAdmin(user)) {
    rows = db.prepare("SELECT json FROM records WHERE store = ? AND deleted_at = 0 ORDER BY updated_at DESC, created_at DESC").all(store);
  } else {
    rows = db.prepare(`
      SELECT r.json
      FROM records r
      JOIN project_members pm ON pm.project_id = r.project_id AND pm.user_id = ?
      WHERE r.store = ? AND r.deleted_at = 0
      ORDER BY r.updated_at DESC, r.created_at DESC
    `).all(user.id, store);
  }
  return rows.map(parseRecord).filter(Boolean);
}

function deleteRecord(store, id, actor = null) {
  if (!DATA_STORES.has(store)) throw new Error(`unsupported store: ${store}`);
  const user = actorOrDefault(actor);
  const row = db.prepare("SELECT project_id, owner_id, json FROM records WHERE store = ? AND id = ? AND deleted_at = 0").get(store, id);
  if (!row) return;
  assertProjectAccess(user, store === "projects" ? id : row.project_id);
  const ts = nowMs();
  const record = parseRecord(row) || {};
  const next = { ...record, deletedAt: ts, updatedAt: ts };
  db.prepare("UPDATE records SET json = ?, updated_at = ?, deleted_at = ? WHERE store = ? AND id = ?")
    .run(JSON.stringify(next), ts, ts, store, id);
  writeAuditLog("record.deleted", store, id, row.project_id || "", { ownerId: row.owner_id || DEFAULT_ADMIN_USER_ID }, user.id);
}

function clearRecords(store, projectId = "", actor = null) {
  if (!DATA_STORES.has(store)) throw new Error(`unsupported store: ${store}`);
  if (store === "projects") throw new Error("projects cannot be cleared");
  const user = actorOrDefault(actor);
  const requested = String(projectId || "").trim();
  let rows = [];
  if (requested) {
    assertProjectAccess(user, requested);
    rows = db.prepare("SELECT id FROM records WHERE store = ? AND project_id = ? AND deleted_at = 0").all(store, requested);
  } else if (isGlobalAdmin(user)) {
    rows = db.prepare("SELECT id FROM records WHERE store = ? AND deleted_at = 0").all(store);
  } else {
    rows = db.prepare(`
      SELECT r.id
      FROM records r
      JOIN project_members pm ON pm.project_id = r.project_id AND pm.user_id = ?
      WHERE r.store = ? AND r.deleted_at = 0
    `).all(user.id, store);
  }
  for (const row of rows) deleteRecord(store, row.id, user);
}

function bootstrapData(projectId = DEFAULT_PROJECT_ID, actor = null) {
  const user = actorOrDefault(actor);
  const resolvedProjectId = resolveProjectIdForUser(user, projectId);
  const data = { projects: listRecords("projects", "", user) };
  for (const store of DATA_STORES) {
    if (store === "projects") continue;
    data[store] = listRecords(store, resolvedProjectId, user);
  }
  data.defaultProjectId = resolvedProjectId;
  return data;
}

function fileBytes(path) {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function scalarCount(sql, params = []) {
  return Number(db.prepare(sql).get(...params)?.count || 0);
}

function groupedCounts(sql, params = []) {
  return db.prepare(sql).all(...params).map((row) => {
    const next = {};
    for (const [key, value] of Object.entries(row)) {
      next[key] = typeof value === "number" ? value : value ?? "";
    }
    return next;
  });
}

function storageOverview() {
  return {
    database: {
      sqlite: true,
      dbBytes: fileBytes(dbFile),
      walBytes: fileBytes(`${dbFile}-wal`),
      shmBytes: fileBytes(`${dbFile}-shm`),
    },
    users: {
      total: scalarCount("SELECT COUNT(*) AS count FROM users"),
      byRole: groupedCounts("SELECT role, COUNT(*) AS count FROM users GROUP BY role ORDER BY role"),
      byStatus: groupedCounts("SELECT status, COUNT(*) AS count FROM users GROUP BY status ORDER BY status"),
    },
    projects: {
      total: scalarCount("SELECT COUNT(*) AS count FROM records WHERE store = 'projects' AND deleted_at = 0"),
      members: scalarCount("SELECT COUNT(*) AS count FROM project_members"),
    },
    records: {
      total: scalarCount("SELECT COUNT(*) AS count FROM records WHERE deleted_at = 0"),
      deleted: scalarCount("SELECT COUNT(*) AS count FROM records WHERE deleted_at > 0"),
      byStore: groupedCounts(`
        SELECT store,
          SUM(CASE WHEN deleted_at = 0 THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN deleted_at > 0 THEN 1 ELSE 0 END) AS deleted
        FROM records
        GROUP BY store
        ORDER BY store
      `),
    },
    tasks: {
      total: scalarCount("SELECT COUNT(*) AS count FROM generation_tasks"),
      byStatus: groupedCounts("SELECT status, COUNT(*) AS count FROM generation_tasks GROUP BY status ORDER BY status"),
    },
    quotas: {
      total: scalarCount("SELECT COUNT(*) AS count FROM user_quotas"),
      limited: scalarCount("SELECT COUNT(*) AS count FROM user_quotas WHERE quota_total >= 0"),
      unlimited: scalarCount("SELECT COUNT(*) AS count FROM user_quotas WHERE quota_total < 0"),
      used: scalarCount("SELECT SUM(quota_used) AS count FROM user_quotas"),
    },
    usageEvents: {
      total: scalarCount("SELECT COUNT(*) AS count FROM usage_events"),
      byStatus: groupedCounts("SELECT status, COUNT(*) AS count FROM usage_events GROUP BY status ORDER BY status"),
      succeeded: scalarCount("SELECT COUNT(*) AS count FROM usage_events WHERE status = 'succeeded'"),
    },
    emailVerifications: {
      total: scalarCount("SELECT COUNT(*) AS count FROM email_verifications"),
      active: scalarCount("SELECT COUNT(*) AS count FROM email_verifications WHERE consumed_at IS NULL AND expires_at > ?", [nowMs()]),
    },
    auditLogs: {
      total: scalarCount("SELECT COUNT(*) AS count FROM audit_logs"),
      latestAt: Number(db.prepare("SELECT MAX(created_at) AS latestAt FROM audit_logs").get()?.latestAt || 0),
    },
  };
}

function userRecordCounts(userId) {
  const counts = {};
  for (const row of groupedCounts(`
    SELECT store, COUNT(*) AS count
    FROM records
    WHERE owner_id = ? AND deleted_at = 0
    GROUP BY store
    ORDER BY store
  `, [userId])) {
    counts[row.store] = Number(row.count || 0);
  }
  return counts;
}

function adminUserRowById(userId) {
  return db.prepare(`
    SELECT
      id,
      username,
      email,
      role,
      status,
      display_name AS displayName,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_login_at AS lastLoginAt
    FROM users
    WHERE id = ?
  `).get(userId) || null;
}

function adminUserSummary(user) {
  ensureQuotaForUser(user);
  const records = userRecordCounts(user.id);
  const latestRecordAt = Number(db.prepare(`
    SELECT MAX(updated_at) AS latestAt
    FROM records
    WHERE owner_id = ? AND deleted_at = 0
  `).get(user.id)?.latestAt || 0);
  const latestUsageAt = Number(db.prepare(`
    SELECT MAX(created_at) AS latestAt
    FROM usage_events
    WHERE user_id = ?
  `).get(user.id)?.latestAt || 0);
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    status: user.status,
    displayName: user.displayName || user.username,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || 0,
    quota: quotaSummaryForUser(user),
    usage: {
      total: scalarCount("SELECT COUNT(*) AS count FROM usage_events WHERE user_id = ?", [user.id]),
      succeeded: scalarCount("SELECT COUNT(*) AS count FROM usage_events WHERE user_id = ? AND status = 'succeeded'", [user.id]),
      refunded: scalarCount("SELECT COUNT(*) AS count FROM usage_events WHERE user_id = ? AND status = 'refunded'", [user.id]),
      latestAt: Math.max(latestUsageAt, latestRecordAt),
    },
    records,
    recordTotal: Object.values(records).reduce((sum, count) => sum + Number(count || 0), 0),
  };
}

function adminUsersOverview() {
  const users = db.prepare(`
    SELECT
      id,
      username,
      email,
      role,
      status,
      display_name AS displayName,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_login_at AS lastLoginAt
    FROM users
    ORDER BY created_at DESC
  `).all();
  ensureQuotasForExistingUsers();
  return {
    overview: {
      users: {
        total: users.length,
        active: users.filter((user) => user.status === "active").length,
        admin: users.filter((user) => user.role === "owner" || user.role === "admin").length,
      },
      usage: {
        succeeded: scalarCount("SELECT COUNT(*) AS count FROM usage_events WHERE status = 'succeeded'"),
        reserved: scalarCount("SELECT COUNT(*) AS count FROM usage_events WHERE status = 'reserved'"),
        refunded: scalarCount("SELECT COUNT(*) AS count FROM usage_events WHERE status = 'refunded'"),
      },
      records: {
        total: scalarCount("SELECT COUNT(*) AS count FROM records WHERE deleted_at = 0"),
        gallery: scalarCount("SELECT COUNT(*) AS count FROM records WHERE store = 'gallery' AND deleted_at = 0"),
        messages: scalarCount("SELECT COUNT(*) AS count FROM records WHERE store = 'messages' AND deleted_at = 0"),
      },
    },
    users: users.map(adminUserSummary),
  };
}

function adminUserDetail(userId) {
  const user = adminUserRowById(userId);
  if (!user) throw new HttpError(404, "用户不存在", "user_not_found");
  const summary = adminUserSummary(user);
  const recordBreakdown = groupedCounts(`
    SELECT store,
      COUNT(*) AS count,
      MAX(updated_at) AS latestAt
    FROM records
    WHERE owner_id = ? AND deleted_at = 0
    GROUP BY store
    ORDER BY store
  `, [user.id]);
  const recentUsage = db.prepare(`
    SELECT
      id,
      project_id AS projectId,
      message_id AS messageId,
      kind,
      status,
      cost,
      input_json AS inputJson,
      output_json AS outputJson,
      error,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM usage_events
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(user.id).map((event) => {
    let input = {};
    let output = {};
    try { input = JSON.parse(event.inputJson || "{}"); } catch {}
    try { output = JSON.parse(event.outputJson || "{}"); } catch {}
    return {
      id: event.id,
      projectId: event.projectId || "",
      messageId: event.messageId || "",
      kind: event.kind,
      status: event.status,
      cost: Number(event.cost || 0),
      input,
      output,
      error: event.error || "",
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    };
  });
  return { ...summary, recordBreakdown, recentUsage };
}

function normalizeQuotaTotal(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) throw new HttpError(400, "请输入有效的总次数", "invalid_quota_total");
  const total = Math.floor(raw);
  if (total < UNLIMITED_QUOTA || total > 100000) throw new HttpError(400, "总次数范围应为 -1 到 100000", "invalid_quota_total");
  return total;
}

function normalizeQuotaUsed(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) throw new HttpError(400, "请输入有效的已用次数", "invalid_quota_used");
  const used = Math.floor(raw);
  if (used < 0 || used > 100000) throw new HttpError(400, "已用次数范围应为 0 到 100000", "invalid_quota_used");
  return used;
}

function updateUserQuota(targetUserId, input = {}, actor = null) {
  const user = adminUserRowById(targetUserId);
  if (!user) throw new HttpError(404, "用户不存在", "user_not_found");
  const quota = ensureQuotaForUser(user);
  const nextTotal = Object.prototype.hasOwnProperty.call(input, "quotaTotal")
    ? normalizeQuotaTotal(input.quotaTotal)
    : Number(quota.quotaTotal);
  const nextUsed = Object.prototype.hasOwnProperty.call(input, "quotaUsed")
    ? normalizeQuotaUsed(input.quotaUsed)
    : Number(quota.quotaUsed || 0);
  const ts = nowMs();
  db.prepare(`
    UPDATE user_quotas
    SET quota_total = ?,
      quota_used = ?,
      updated_at = ?,
      updated_by = ?
    WHERE user_id = ?
  `).run(nextTotal, nextUsed, ts, actor?.id || DEFAULT_ADMIN_USER_ID, targetUserId);
  writeAuditLog("quota.updated", "user", targetUserId, "", {
    quotaTotal: nextTotal,
    quotaUsed: nextUsed,
  }, actor?.id || DEFAULT_ADMIN_USER_ID);
  return adminUserDetail(targetUserId);
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

function loadConfig() {
  return {
    ...parseEnvFile(skillEnvFile),
    ...parseEnvFile(join(workspaceDir, ".env")),
    ...parseEnvFile(join(rootDir, ".env")),
    ...process.env,
  };
}

function pick(config, names, fallback = "") {
  for (const name of names) {
    if (config[name]) return String(config[name]).trim();
  }
  return fallback;
}

function authConfig() {
  const config = loadConfig();
  const authRequiredRaw = pick(config, ["PICSET_AUTH_REQUIRED"], "1").toLowerCase();
  return {
    authRequired: !["0", "false", "no", "off"].includes(authRequiredRaw),
    appName: pick(config, ["PICSET_APP_NAME"], "PicSet"),
    basePath: normalizeBasePath(pick(config, ["PICSET_BASE_PATH"], DEFAULT_BASE_PATH)),
    resendApiKey: pick(config, ["RESEND_API_KEY"], ""),
    resendFrom: pick(config, ["RESEND_FROM"], ""),
    resendReplyTo: pick(config, ["RESEND_REPLY_TO"], ""),
    authSecret: pick(config, ["PICSET_AUTH_SECRET", "PICSET_SESSION_SECRET", "RESEND_API_KEY", "VSLLM_API_KEY", "OPENAI_API_KEY"], "picset-local-dev-secret"),
    devAuthCode: ["1", "true", "yes"].includes(pick(config, ["PICSET_DEV_AUTH_CODE"], "").toLowerCase()),
    cookieSecure: ["1", "true", "yes"].includes(pick(config, ["PICSET_COOKIE_SECURE"], "").toLowerCase()),
  };
}

function normalizeBasePath(path) {
  const raw = String(path || "").trim();
  if (!raw || raw === "/") return "";
  return `/${raw.replace(/^\/+|\/+$/g, "")}`;
}

function normalizeRequestPath(pathname) {
  const basePath = authConfig().basePath;
  if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
    return pathname.slice(basePath.length) || "/";
  }
  return pathname;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeUsername(username, email = "") {
  const local = normalizeEmail(email).split("@")[0] || "user";
  const base = String(username || local)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || `user_${randomBytes(3).toString("hex")}`;
  return base.length >= 3 ? base : `${base}_${randomBytes(2).toString("hex")}`;
}

function uniqueUsername(username, email = "") {
  const base = normalizeUsername(username, email);
  let candidate = base;
  for (let i = 0; i < 20; i++) {
    const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(candidate);
    if (!existing) return candidate;
    candidate = `${base}_${randomInt(1000, 9999)}`;
  }
  return `${base}_${Date.now().toString(36)}`;
}

function requestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "";
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const cookies = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function secureCookieForRequest(req, cfg = authConfig()) {
  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return cfg.cookieSecure || proto === "https";
}

function sessionCookie(token, req) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (secureCookieForRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(req) {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (secureCookieForRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function codeHash(email, purpose, code) {
  const cfg = authConfig();
  return hashToken(`${cfg.authSecret}:${purpose}:${normalizeEmail(email)}:${String(code).trim()}`);
}

function createVerificationCode() {
  return String(randomInt(100000, 1000000));
}

function assertVerificationRateLimit(email, purpose, req) {
  const ts = nowMs();
  const recent = db.prepare(`
    SELECT MAX(sent_at) AS latest
    FROM email_verifications
    WHERE email = ? AND purpose = ? AND sent_at > ?
  `).get(email, purpose, ts - VERIFICATION_RESEND_COOLDOWN_MS);
  if (recent?.latest) {
    const retryAfter = Math.max(1, Math.ceil((recent.latest + VERIFICATION_RESEND_COOLDOWN_MS - ts) / 1000));
    throw new HttpError(429, `验证码发送过于频繁，请 ${retryAfter} 秒后再试`, "code_cooldown");
  }

  const emailCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM email_verifications
    WHERE email = ? AND sent_at > ?
  `).get(email, ts - 60 * 60 * 1000)?.count || 0);
  if (emailCount >= VERIFICATION_EMAIL_HOURLY_LIMIT) {
    throw new HttpError(429, "这个邮箱一小时内发送次数过多，请稍后再试", "email_rate_limited");
  }

  const ip = requestIp(req);
  const ipCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM email_verifications
    WHERE ip = ? AND sent_at > ?
  `).get(ip, ts - 60 * 60 * 1000)?.count || 0);
  if (ip && ipCount >= VERIFICATION_IP_HOURLY_LIMIT) {
    throw new HttpError(429, "当前网络发送次数过多，请稍后再试", "ip_rate_limited");
  }
}

function insertVerification(email, purpose, code, req) {
  const ts = nowMs();
  const expiresAt = ts + VERIFICATION_TTL_MS;
  const id = storageId("verify");
  db.prepare(`
    INSERT INTO email_verifications (id, email, purpose, code_hash, attempts, expires_at, created_at, sent_at, ip, user_agent, consumed_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    email,
    purpose,
    codeHash(email, purpose, code),
    expiresAt,
    ts,
    ts,
    requestIp(req),
    String(req.headers["user-agent"] || "").slice(0, 500),
  );
  return { id, expiresAt };
}

function deleteVerification(id) {
  if (!id) return;
  db.prepare("DELETE FROM email_verifications WHERE id = ? AND consumed_at IS NULL").run(id);
}

async function sendVerificationEmail(email, purpose, code) {
  const cfg = authConfig();
  if (!cfg.resendApiKey || !cfg.resendFrom) {
    if (cfg.devAuthCode) return { dev: true };
    throw new HttpError(503, "Resend 未配置，请设置 RESEND_API_KEY 和 RESEND_FROM", "resend_not_configured");
  }
  const title = purpose === "register" ? "注册验证码" : "登录验证码";
  const subject = `${cfg.appName} ${title}`;
  const escapedCode = String(code).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[ch]);
  const payload = {
    from: cfg.resendFrom,
    to: email,
    subject,
    text: `${cfg.appName} ${title}：${code}\n验证码 10 分钟内有效。若非本人操作，请忽略这封邮件。`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#17201a">
        <h2 style="margin:0 0 12px">${cfg.appName} ${title}</h2>
        <p>你的验证码是：</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${escapedCode}</p>
        <p>验证码 10 分钟内有效。若非本人操作，请忽略这封邮件。</p>
      </div>
    `,
  };
  if (cfg.resendReplyTo) payload.reply_to = cfg.resendReplyTo;
  const upstream = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.resendApiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "picset-auth/1.0",
    },
    body: JSON.stringify(payload),
  });
  const raw = await upstream.text();
  if (!upstream.ok) {
    let message = raw.slice(0, 800) || `Resend HTTP ${upstream.status}`;
    try {
      const json = JSON.parse(raw);
      message = json?.message || json?.error?.message || message;
    } catch {}
    throw new HttpError(502, `Resend 发送失败：${message}`, "resend_send_failed");
  }
  return { dev: false };
}

function latestVerification(email, purpose) {
  return db.prepare(`
    SELECT *
    FROM email_verifications
    WHERE email = ? AND purpose = ? AND consumed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(email, purpose) || null;
}

function verifyEmailCode(email, purpose, code) {
  const row = latestVerification(email, purpose);
  if (!row) throw new HttpError(400, "验证码不存在或已过期，请重新发送", "code_missing");
  const ts = nowMs();
  if (row.expires_at <= ts) throw new HttpError(400, "验证码已过期，请重新发送", "code_expired");
  if (Number(row.attempts || 0) >= VERIFICATION_MAX_ATTEMPTS) {
    throw new HttpError(429, "验证码尝试次数过多，请重新发送", "code_attempts_exceeded");
  }
  if (row.code_hash !== codeHash(email, purpose, code)) {
    db.prepare("UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    throw new HttpError(400, "验证码不正确", "code_invalid");
  }
  db.prepare("UPDATE email_verifications SET consumed_at = ? WHERE id = ?").run(ts, row.id);
}

function createSession(user, req) {
  const token = randomBytes(32).toString("base64url");
  const ts = nowMs();
  const expiresAt = ts + SESSION_TTL_MS;
  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, updated_at, user_agent, ip, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    storageId("sess"),
    user.id,
    hashToken(token),
    expiresAt,
    ts,
    ts,
    String(req.headers["user-agent"] || "").slice(0, 500),
    requestIp(req),
  );
  db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, user.id);
  writeAuditLog("session.created", "user", user.id, "", { ip: requestIp(req) }, user.id);
  return token;
}

function getSessionFromRequest(req) {
  const token = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!token) return null;
  return db.prepare(`
    SELECT s.id AS sessionId, s.user_id AS userId, u.id, u.username, u.email, u.role, u.status,
      u.display_name AS displayName, u.created_at AS createdAt, u.updated_at AS updatedAt, u.last_login_at AS lastLoginAt
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
    LIMIT 1
  `).get(hashToken(token), nowMs()) || null;
}

function currentUserFromRequest(req) {
  const cfg = authConfig();
  const session = getSessionFromRequest(req);
  if (session?.id && session.status === "active") return session;
  if (!cfg.authRequired) return defaultActor();
  return null;
}

function requireCurrentUser(req) {
  const user = currentUserFromRequest(req);
  if (!user) throw new HttpError(401, "请先登录", "auth_required");
  return user;
}

function revokeSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!token) return;
  db.prepare("UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .run(nowMs(), nowMs(), hashToken(token));
}

function userByEmail(email) {
  return db.prepare(`
    SELECT id, username, email, role, status, display_name AS displayName, created_at AS createdAt, updated_at AS updatedAt, last_login_at AS lastLoginAt
    FROM users
    WHERE email = ?
  `).get(email) || null;
}

function createUserFromRegistration(email, input = {}) {
  const ts = nowMs();
  const firstHuman = activeHumanUserCount() === 0;
  const role = firstHuman ? "owner" : "member";
  const user = {
    id: storageId("user"),
    username: uniqueUsername(input.username, email),
    email,
    role,
    status: "active",
    displayName: String(input.displayName || input.username || email.split("@")[0]).trim().slice(0, 80),
  };
  db.prepare(`
    INSERT INTO users (id, username, email, password_hash, role, status, display_name, created_at, updated_at, last_login_at)
    VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?, NULL)
  `).run(user.id, user.username, user.email, user.role, user.displayName, ts, ts);
  ensureQuotaForUser(user);
  writeAuditLog("user.registered", "user", user.id, "", { email, role }, user.id);
  if (firstHuman) {
    const projects = db.prepare("SELECT id FROM records WHERE store = 'projects' AND deleted_at = 0").all();
    for (const project of projects) ensureProjectMember(project.id, user.id, "owner");
  } else {
    ensureUserProject(user);
  }
  return getUserById(user.id);
}

function normalizeApiBaseUrl(raw) {
  let url = String(raw || DEFAULT_API_BASE).trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/(responses|models|chat\/completions)$/i, "");
  if (!/\/v1$/i.test(url)) url += "/v1";
  return url;
}

function buildApiUrl(baseUrl, path) {
  return `${normalizeApiBaseUrl(baseUrl)}/${String(path || "").replace(/^\/+/, "")}`;
}

function normalizeEnhanceModel(model) {
  const value = String(model || "").trim();
  return ENHANCE_MODEL_OPTIONS.some((item) => item.id === value) ? value : DEFAULT_ENHANCE_MODEL;
}

function getRuntimeConfig(overrides = {}) {
  const config = loadConfig();
  const apiKey = overrides.apiKey || pick(config, ["VSLLM_API_KEY", "OPENAI_API_KEY", "HF_IMAGE_API_KEY", "key"]);
  const baseUrl = normalizeApiBaseUrl(overrides.apiBase || pick(config, ["VSLLM_API_BASE_URL", "OPENAI_BASE_URL", "HF_IMAGE_API_BASE_URL", "url"], DEFAULT_API_BASE));
  const imageModel = DEFAULT_IMAGE_MODEL;
  const toolModel = overrides.toolModel || pick(config, ["VSLLM_IMAGE_TOOL_MODEL"], DEFAULT_TOOL_MODEL);
  const enhanceModel = normalizeEnhanceModel(overrides.enhanceModel || pick(config, ["VSLLM_ENHANCE_MODEL"], DEFAULT_ENHANCE_MODEL));
  return { apiKey, baseUrl, imageModel, toolModel, enhanceModel };
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 30 * 1024 * 1024) throw new Error("request body too large");
  }
  return body ? JSON.parse(body) : {};
}

async function sendAuthCode(req, res, purpose) {
  const input = await readJson(req);
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new HttpError(400, "请输入有效邮箱", "invalid_email");
  const existing = userByEmail(email);
  if (purpose === "register" && existing) {
    const message = existing.status === "active" ? "该邮箱已注册，请直接登录" : "该邮箱已存在但不可注册，请联系管理员";
    throw new HttpError(409, message, "email_registered");
  }
  if (purpose === "login" && (!existing || existing.status !== "active")) {
    throw new HttpError(404, "该邮箱还没有可登录账号，请先注册", "email_not_registered");
  }
  assertVerificationRateLimit(email, purpose, req);
  const code = createVerificationCode();
  const verification = insertVerification(email, purpose, code, req);
  let sent;
  try {
    sent = await sendVerificationEmail(email, purpose, code);
  } catch (error) {
    deleteVerification(verification.id);
    throw error;
  }
  writeAuditLog("auth.code_sent", "user", existing?.id || "", "", { email, purpose }, existing?.id || DEFAULT_ADMIN_USER_ID);
  const data = {
    ok: true,
    email,
    purpose,
    cooldownSeconds: Math.ceil(VERIFICATION_RESEND_COOLDOWN_MS / 1000),
    expiresInSeconds: Math.ceil((verification.expiresAt - nowMs()) / 1000),
    resendConfigured: !sent.dev,
  };
  if (sent.dev) data.devCode = code;
  sendJson(res, 200, data);
}

async function verifyRegistration(req, res) {
  const input = await readJson(req);
  const email = normalizeEmail(input.email);
  const code = String(input.code || "").trim();
  if (!isValidEmail(email)) throw new HttpError(400, "请输入有效邮箱", "invalid_email");
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, "请输入 6 位验证码", "invalid_code");
  const existing = userByEmail(email);
  if (existing) {
    const message = existing.status === "active" ? "该邮箱已注册，请直接登录" : "该邮箱已存在但不可注册，请联系管理员";
    throw new HttpError(409, message, "email_registered");
  }
  verifyEmailCode(email, "register", code);
  const user = createUserFromRegistration(email, input);
  const token = createSession(user, req);
  const defaultProjectId = resolveProjectIdForUser(user, input.projectId || "");
  sendJson(res, 200, {
    ok: true,
    authenticated: true,
    user: publicUser(user),
    defaultProjectId,
  }, { "Set-Cookie": sessionCookie(token, req) });
}

async function verifyLogin(req, res) {
  const input = await readJson(req);
  const email = normalizeEmail(input.email);
  const code = String(input.code || "").trim();
  if (!isValidEmail(email)) throw new HttpError(400, "请输入有效邮箱", "invalid_email");
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, "请输入 6 位验证码", "invalid_code");
  const user = userByEmail(email);
  if (!user || user.status !== "active") throw new HttpError(404, "该邮箱还没有可登录账号，请先注册", "email_not_registered");
  verifyEmailCode(email, "login", code);
  const token = createSession(user, req);
  const defaultProjectId = resolveProjectIdForUser(user, input.projectId || "");
  sendJson(res, 200, {
    ok: true,
    authenticated: true,
    user: publicUser(user),
    defaultProjectId,
  }, { "Set-Cookie": sessionCookie(token, req) });
}

function sendAuthMe(req, res) {
  const cfg = authConfig();
  const user = currentUserFromRequest(req);
  sendJson(res, 200, {
    authenticated: Boolean(user),
    authRequired: cfg.authRequired,
    resendConfigured: Boolean(cfg.resendApiKey && cfg.resendFrom),
    devAuthCode: cfg.devAuthCode,
    user: publicUser(user),
    defaultProjectId: user ? resolveProjectIdForUser(user, "") : DEFAULT_PROJECT_ID,
  });
}

function logout(req, res) {
  const user = currentUserFromRequest(req);
  revokeSession(req);
  if (user) writeAuditLog("session.revoked", "user", user.id, "", { ip: requestIp(req) }, user.id);
  sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie(req) });
}

function mimeType(path) {
  const ext = extname(path).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  }[ext] || "application/octet-stream";
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function safePrompt(prompt, seed) {
  const text = String(prompt || "").trim();
  if (seed && Number(seed) > 0) return `${text}\n种子:${Math.floor(Number(seed))}`;
  return text;
}

function buildImagePayload(input) {
  const cfg = getRuntimeConfig(input || {});
  const prompt = safePrompt(input.prompt, input.seed);
  let instruction = "Use the image_generation tool to generate exactly one image. 不要输出长篇文字说明，只生成图片。";
  if (prompt) instruction += `\n提示词：${prompt}`;
  const inputImages = Array.isArray(input.images) ? input.images.filter(Boolean) : [];
  if (inputImages.length) instruction += "\n【重要指令】：请务必参考我附带的图片特征进行画面的修改、变体或延续生成。";

  const content = [{ type: "input_text", text: instruction }];
  for (const image of inputImages) {
    content.push({ type: "input_image", image_url: String(image) });
  }

  const format = input.format || "png";
  const imageTool = {
    type: "image_generation",
    model: cfg.toolModel,
    output_format: format,
    quality: input.quality || "high",
    partial_images: 2,
  };
  if (input.size && input.size !== "auto") imageTool.size = input.size;

  const payload = {
    model: cfg.imageModel,
    input: [{ role: "user", content }],
    tools: [imageTool],
    instructions: "You are a helpful assistant. Always call image_generation when the user asks for an image. Do not answer with only text.",
    tool_choice: { type: "image_generation" },
    stream: input.stream !== false,
    store: false,
  };
  if (input.reasoning && input.reasoning !== "off") {
    payload.reasoning = { effort: input.reasoning, summary: "auto" };
    payload.text = { verbosity: "medium" };
    payload.include = ["reasoning.encrypted_content"];
  }
  return { cfg, payload, prompt, format };
}

function extractImage(data) {
  if (!data || typeof data !== "object") return null;
  if (typeof data._latestImg === "string") return data._latestImg;
  if (typeof data.partial_image_b64 === "string") return data.partial_image_b64;
  const item = data.item;
  if (item && item.type === "image_generation_call") {
    for (const key of ["result", "image_base64", "b64_json"]) {
      if (typeof item[key] === "string") return item[key];
    }
  }
  const outputs = data.output || data.response?.output || [];
  if (Array.isArray(outputs)) {
    for (const output of outputs) {
      if (!output || typeof output !== "object") continue;
      if (output.type === "image_generation_call") {
        for (const key of ["result", "image_base64", "b64_json"]) {
          if (typeof output[key] === "string") return output[key];
        }
      }
      if (Array.isArray(output.content)) {
        for (const part of output.content) {
          for (const key of ["image_base64", "b64_json", "image"]) {
            if (typeof part?.[key] === "string") return part[key];
          }
        }
      }
    }
  }
  return null;
}

function extractUsage(data) {
  const usage = data?.usage || data?.response?.usage || data?._latestUsage;
  if (!usage || typeof usage !== "object") return null;
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.input;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.output;
  const total = usage.total_tokens ?? usage.total;
  return { input, output, total };
}

function eventLabel(type, data) {
  const item = data?.item;
  if (/keepalive/i.test(type || "")) return "后台任务仍在生成中";
  if (/partial_image/i.test(type || "")) return "收到部分预览图";
  if (/image_generation_call\.completed$/i.test(type || "")) return "图片渲染完成";
  if (/image_generation_call\.in_progress/i.test(type || "")) return "图片渲染中";
  if (/image_generation_call\.generating/i.test(type || "")) return "图片生成中";
  if (/output_item\.added$/i.test(type || "") && item?.type === "image_generation_call") return "开始渲染图片";
  if (/output_item\.done$/i.test(type || "")) return item?.type === "image_generation_call" ? "图片渲染完成" : "输出处理完成";
  if (/response\.created/i.test(type || "")) return "请求已创建";
  if (/response\.in_progress/i.test(type || "")) return "上游正在处理";
  if (/response\.completed/i.test(type || "")) return "生成完成";
  return type || "事件";
}

function parseSseEvent(raw) {
  const lines = raw.split(/\r?\n/);
  let eventName = "";
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^\s/, ""));
  }
  if (!dataLines.length) return null;
  const dataText = dataLines.join("\n");
  if (dataText.trim() === "[DONE]") return { type: "done", data: null };
  try {
    const data = JSON.parse(dataText);
    return { type: data.type || eventName || "upstream.event", data };
  } catch {
    return null;
  }
}

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function taskLogLine(label) {
  return `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${label}`;
}

function imageMimeForFormat(format = "png") {
  const normalized = String(format || "png").toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "webp") return "image/webp";
  return "image/png";
}

function imageExtensionForFormat(format = "png") {
  const normalized = String(format || "png").toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "jpg";
  if (normalized === "webp") return "webp";
  return "png";
}

function imageFormatFromMime(mime = "") {
  const normalized = String(mime || "").toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpeg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("png")) return "png";
  return "";
}

function normalizeImageForClient(image, format = "png") {
  const raw = String(image || "");
  if (!raw) return "";
  if (/^(data:|https?:\/\/|blob:|\/|api\/)/i.test(raw)) return raw;
  return `data:${imageMimeForFormat(format)};base64,${raw.replace(/\s+/g, "")}`;
}

function generationTaskById(taskId) {
  return db.prepare(`
    SELECT
      id,
      project_id AS projectId,
      owner_id AS ownerId,
      type,
      status,
      progress,
      input_json AS inputJson,
      output_json AS outputJson,
      error,
      created_at AS createdAt,
      updated_at AS updatedAt,
      started_at AS startedAt,
      finished_at AS finishedAt,
      usage_event_id AS usageEventId,
      cancel_requested AS cancelRequested
    FROM generation_tasks
    WHERE id = ?
  `).get(taskId) || null;
}

function assertGenerationTaskAccess(user, task) {
  if (!task) throw new HttpError(404, "生成任务不存在", "task_not_found");
  if (task.ownerId === user.id || canAccessProject(user, task.projectId)) return;
  throw new HttpError(403, "没有这个生成任务的访问权限", "task_forbidden");
}

function publicGenerationTask(row) {
  if (!row) return null;
  const input = safeJsonParse(row.inputJson, {});
  const output = safeJsonParse(row.outputJson, {});
  const safeInput = { ...input };
  delete safeInput.apiKey;
  return {
    id: row.id,
    projectId: row.projectId,
    ownerId: row.ownerId,
    type: row.type,
    status: row.status,
    progress: Number(row.progress || 0),
    input: safeInput,
    output,
    logs: Array.isArray(output.logs) ? output.logs : [],
    error: row.error || "",
    cancelRequested: Boolean(row.cancelRequested),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    startedAt: Number(row.startedAt || 0),
    finishedAt: Number(row.finishedAt || 0),
  };
}

function isTerminalGenerationStatus(status) {
  return ["succeeded", "failed", "cancelled"].includes(String(status || ""));
}

function updateGenerationTask(taskId, patch = {}) {
  const columns = {
    status: "status",
    progress: "progress",
    inputJson: "input_json",
    outputJson: "output_json",
    error: "error",
    startedAt: "started_at",
    finishedAt: "finished_at",
    usageEventId: "usage_event_id",
    cancelRequested: "cancel_requested",
    updatedAt: "updated_at",
  };
  const assignments = [];
  const values = [];
  const next = { ...patch };
  if (!Object.prototype.hasOwnProperty.call(next, "updatedAt")) next.updatedAt = nowMs();
  for (const [key, value] of Object.entries(next)) {
    const column = columns[key];
    if (!column) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (!assignments.length) return;
  db.prepare(`UPDATE generation_tasks SET ${assignments.join(", ")} WHERE id = ?`).run(...values, taskId);
}

function appendGenerationTaskLog(output, label) {
  if (!label) return output;
  const logs = Array.isArray(output.logs) ? output.logs : [];
  return { ...output, logs: [...logs, taskLogLine(label)].slice(-50) };
}

function updateGenerationTaskOutput(taskId, mutate, patch = {}) {
  const row = generationTaskById(taskId);
  if (!row) return null;
  const current = safeJsonParse(row.outputJson, {});
  const next = typeof mutate === "function" ? mutate({ ...current }) : { ...current, ...(mutate || {}) };
  updateGenerationTask(taskId, { ...patch, outputJson: JSON.stringify(next || {}) });
  return next;
}

function taskCancelRequested(taskId) {
  const row = generationTaskById(taskId);
  return !row || row.status === "cancelled" || Number(row.cancelRequested || 0) === 1;
}

function makeAbortError(message = "生成任务已取消") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function generationTaskReservation(row) {
  const output = safeJsonParse(row?.outputJson, {});
  return {
    id: row?.usageEventId || output.usageEventId || "",
    userId: row?.ownerId || "",
    settled: false,
    quota: output.quota || quotaSummaryForUser(row?.ownerId || ""),
  };
}

function setGenerationTaskProgress(taskId, progress, label = "", extra = {}) {
  const row = generationTaskById(taskId);
  if (!row || isTerminalGenerationStatus(row.status) || Number(row.cancelRequested || 0) === 1) return false;
  const currentProgress = Math.max(0, Math.min(99, Math.floor(Number(row.progress || 0))));
  const requestedProgress = Math.max(0, Math.min(99, Math.floor(Number(progress || 0))));
  updateGenerationTaskOutput(taskId, (output) => appendGenerationTaskLog({ ...output, ...extra, label }, label), {
    status: "running",
    progress: Math.max(currentProgress, requestedProgress),
  });
  return true;
}

async function saveGeneratedImage(taskId, image, format = "png") {
  const raw = String(image || "");
  if (!raw) throw new Error("图片数据为空");
  if (/^https?:\/\//i.test(raw)) {
    return { image: raw, imageUrl: raw, bytes: 0, format, external: true };
  }

  let mime = imageMimeForFormat(format);
  let base64 = raw;
  const match = raw.match(/^data:([^;]+);base64,(.*)$/is);
  if (match) {
    mime = match[1].toLowerCase();
    base64 = match[2];
  }
  const buffer = Buffer.from(base64.replace(/\s+/g, ""), "base64");
  if (!buffer.length) throw new Error("图片数据为空");

  const normalizedFormat = imageFormatFromMime(mime) || format || "png";
  const ext = imageExtensionForFormat(normalizedFormat);
  const date = new Date();
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dir = join(generatedDir, year, month);
  mkdirSync(dir, { recursive: true });
  const fileName = `${taskId}.${ext}`;
  const filePath = join(dir, fileName);
  await writeFile(filePath, buffer);
  const imageUrl = `api/generated/${year}/${month}/${fileName}`;
  return {
    image: imageUrl,
    imageUrl,
    bytes: buffer.length,
    format: normalizedFormat,
    mimeType: mime,
    path: `${year}/${month}/${fileName}`,
  };
}

async function completeGenerationTask(taskId, row, image, usage, format, startedAt) {
  if (taskCancelRequested(taskId)) throw makeAbortError();
  const saved = await saveGeneratedImage(taskId, image, format);
  if (taskCancelRequested(taskId)) throw makeAbortError();
  const elapsedMs = Date.now() - startedAt;
  const reservation = generationTaskReservation(row);
  const quota = commitGenerationCredit(reservation, {
    usage,
    elapsedMs,
    format: saved.format || format,
    imageUrl: saved.imageUrl,
    bytes: saved.bytes,
    taskId,
  });
  updateGenerationTaskOutput(taskId, (output) => appendGenerationTaskLog({
    ...output,
    ...saved,
    usage: usage || null,
    elapsedMs,
    quota,
    partial: "",
  }, "生成完成，图片已保存"), {
    status: "succeeded",
    progress: 100,
    error: null,
    finishedAt: nowMs(),
  });
}

function cancelGenerationTaskRecord(taskId, reason = "用户取消了生成任务") {
  const row = generationTaskById(taskId);
  if (!row) return null;
  if (isTerminalGenerationStatus(row.status)) return publicGenerationTask(row);
  const reservation = generationTaskReservation(row);
  const quota = refundGenerationCredit(reservation, reason);
  updateGenerationTaskOutput(taskId, (output) => appendGenerationTaskLog({ ...output, quota, error: reason }, reason), {
    status: "cancelled",
    progress: Math.max(0, Number(row.progress || 0)),
    error: reason,
    cancelRequested: 1,
    finishedAt: nowMs(),
  });
  return publicGenerationTask(generationTaskById(taskId));
}

function failGenerationTaskRecord(taskId, reason = "生成任务失败") {
  const row = generationTaskById(taskId);
  if (!row) return null;
  if (isTerminalGenerationStatus(row.status)) return publicGenerationTask(row);
  const reservation = generationTaskReservation(row);
  const quota = refundGenerationCredit(reservation, reason);
  updateGenerationTaskOutput(taskId, (output) => appendGenerationTaskLog({ ...output, quota, error: reason }, reason), {
    status: "failed",
    progress: Math.max(0, Number(row.progress || 0)),
    error: reason,
    finishedAt: nowMs(),
  });
  return publicGenerationTask(generationTaskById(taskId));
}

async function runGenerationTask(taskId) {
  if (generationWorkers.has(taskId)) return;
  let row = generationTaskById(taskId);
  if (!row || isTerminalGenerationStatus(row.status)) return;

  const input = safeJsonParse(row.inputJson, {});
  const { cfg, payload, format } = buildImagePayload(input);
  const controller = new AbortController();
  generationWorkers.set(taskId, { controller });

  const startedAt = Date.now();
  let keepaliveTimer = null;
  let latestImage = null;
  let latestUsage = null;
  let finalResponse = null;
  let failedMessage = "";
  let eventCount = 0;
  const partialPreviewLimit = 1_600_000;

  try {
    if (Number(row.cancelRequested || 0) === 1) throw makeAbortError();
    if (!cfg.apiKey) throw new Error("missing API key in env");
    updateGenerationTask(taskId, { status: "running", progress: 10, startedAt: nowMs(), error: null });
    setGenerationTaskProgress(taskId, 12, "后台任务开始请求上游接口", {
      model: payload.model,
      toolModel: payload.tools[0].model,
      size: payload.tools[0].size || "auto",
      quality: payload.tools[0].quality,
      format,
    });

    const upstream = await fetch(buildApiUrl(cfg.baseUrl, "responses"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
        "Accept": payload.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const raw = await upstream.text();
      let message = raw.slice(0, 1200);
      try {
        const json = JSON.parse(raw);
        message = json?.error?.message || json?.message || JSON.stringify(json).slice(0, 1200);
      } catch {}
      throw new Error(message || `HTTP ${upstream.status}`);
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") || !upstream.body) {
      const data = await upstream.json();
      const image = extractImage(data);
      if (!image) throw new Error("API 返回成功，但没有找到图片数据");
      await completeGenerationTask(taskId, row, image, extractUsage(data), format, startedAt);
      return;
    }

    keepaliveTimer = setInterval(() => {
      setGenerationTaskProgress(taskId, 65, "后台任务仍在生成中", { elapsedMs: Date.now() - startedAt });
    }, 25000);

    const flush = (raw) => {
      if (taskCancelRequested(taskId)) throw makeAbortError();
      const event = parseSseEvent(raw);
      if (!event) return;
      eventCount += 1;
      const { type, data } = event;
      if (failedMessage) return;
      if (data?.error) {
        failedMessage = data.error.message || String(data.error);
        setGenerationTaskProgress(taskId, 85, failedMessage, { eventType: type, eventCount });
        return;
      }
      if (type === "response.failed") {
        failedMessage = data?.response?.error?.message || data?.error?.message || "上游生成失败";
        setGenerationTaskProgress(taskId, 85, failedMessage, { eventType: type, eventCount });
        return;
      }
      const image = extractImage(data);
      if (image) latestImage = image;
      const usage = extractUsage(data);
      if (usage) latestUsage = usage;
      if (data?.response) finalResponse = data.response;
      if (type === "response.completed") finalResponse = data.response || data;
      const partial = typeof data?.partial_image_b64 === "string" ? data.partial_image_b64 : "";
      const extra = {
        eventType: type,
        eventCount,
        partialIndex: typeof data?.partial_image_index === "number" ? data.partial_image_index : null,
        elapsedMs: Date.now() - startedAt,
      };
      if (partial && partial.length <= partialPreviewLimit) {
        extra.partial = normalizeImageForClient(partial, format);
      }
      const ok = setGenerationTaskProgress(
        taskId,
        Math.min(88, Math.max(20, 20 + eventCount * 7)),
        eventLabel(type, data),
        extra,
      );
      if (!ok) throw makeAbortError();
    };

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of upstream.body) {
      if (taskCancelRequested(taskId)) throw makeAbortError();
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";
      for (const part of parts) flush(part);
    }
    if (buffer.trim()) flush(buffer);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = null;

    if (failedMessage) throw new Error(failedMessage);
    if (!latestImage && finalResponse) {
      latestImage = extractImage(finalResponse);
      latestUsage = latestUsage || extractUsage(finalResponse);
    }
    if (!latestImage) throw new Error("流结束，但未能提取图片数据");
    await completeGenerationTask(taskId, row, latestImage, latestUsage, format, startedAt);
  } catch (error) {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    const cancelled = error?.name === "AbortError" || controller.signal.aborted || taskCancelRequested(taskId);
    if (cancelled) {
      cancelGenerationTaskRecord(taskId, "用户取消了生成任务");
    } else {
      failGenerationTaskRecord(taskId, error?.message || String(error));
    }
  } finally {
    generationWorkers.delete(taskId);
  }
}

function scheduleGenerationTask(taskId) {
  setTimeout(() => {
    runGenerationTask(taskId).catch((error) => {
      failGenerationTaskRecord(taskId, error?.message || String(error));
    });
  }, 0);
}

async function createGenerationTask(req, res, user) {
  const input = await readJson(req);
  const projectId = resolveProjectIdForUser(user, input.projectId || "");
  const taskInput = { ...input, projectId };
  const { cfg, payload, format } = buildImagePayload(taskInput);
  if (!cfg.apiKey) {
    sendJson(res, 400, { error: "missing API key in env" });
    return;
  }

  let reservation = null;
  try {
    reservation = reserveGenerationCredit(user, taskInput);
    const taskId = storageId("task");
    const ts = nowMs();
    const output = {
      logs: [taskLogLine("后台生成任务已创建")],
      quota: reservation.quota,
      usageEventId: reservation.id,
      model: payload.model,
      toolModel: payload.tools[0].model,
      size: payload.tools[0].size || "auto",
      quality: payload.tools[0].quality,
      format,
    };
    db.prepare(`
      INSERT INTO generation_tasks (
        id, project_id, owner_id, type, status, progress, input_json, output_json, error,
        created_at, updated_at, started_at, finished_at, usage_event_id, cancel_requested
      )
      VALUES (?, ?, ?, 'image_generation', 'queued', 5, ?, ?, NULL, ?, ?, NULL, NULL, ?, 0)
    `).run(
      taskId,
      projectId,
      user.id,
      JSON.stringify(taskInput),
      JSON.stringify(output),
      ts,
      ts,
      reservation.id,
    );
    scheduleGenerationTask(taskId);
    sendJson(res, 202, { task: publicGenerationTask(generationTaskById(taskId)) });
  } catch (error) {
    if (reservation && !reservation.settled) refundGenerationCredit(reservation, error?.message || String(error));
    throw error;
  }
}

function getGenerationTask(req, res, user, taskId) {
  const row = generationTaskById(taskId);
  assertGenerationTaskAccess(user, row);
  sendJson(res, 200, { task: publicGenerationTask(row) });
}

function cancelGenerationTask(req, res, user, taskId) {
  const row = generationTaskById(taskId);
  assertGenerationTaskAccess(user, row);
  if (!isTerminalGenerationStatus(row.status)) {
    updateGenerationTask(taskId, { cancelRequested: 1 });
    const worker = generationWorkers.get(taskId);
    if (worker?.controller) worker.controller.abort();
  }
  const task = cancelGenerationTaskRecord(taskId, "用户取消了生成任务") || publicGenerationTask(generationTaskById(taskId));
  sendJson(res, 200, { task });
}

function recoverInterruptedGenerationTasks() {
  const rows = db.prepare(`
    SELECT id
    FROM generation_tasks
    WHERE status IN ('queued', 'running')
  `).all();
  for (const row of rows) {
    failGenerationTaskRecord(row.id, "服务重启后任务已中断，请重新提交");
  }
}

async function serveGeneratedFile(req, res, user, relPath) {
  requireCurrentUser(req);
  const cleanRelPath = String(relPath || "").replace(/^\/+/, "");
  const filePath = resolve(generatedDir, cleanRelPath);
  const allowedRoot = `${generatedDir}/`;
  if (filePath !== generatedDir && !filePath.startsWith(allowedRoot)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  const data = req.method === "HEAD" ? null : await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": mimeType(filePath),
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  res.end(data);
}

async function proxyGenerate(req, res, user) {
  const input = await readJson(req);
  const { cfg, payload, format } = buildImagePayload(input);
  if (!cfg.apiKey) {
    sendJson(res, 400, { error: "missing API key in env" });
    return;
  }
  const reservation = reserveGenerationCredit(user, input);
  let keepaliveTimer = null;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Connection": "keep-alive",
  });

  const controller = new AbortController();
  req.on("close", () => controller.abort());
  const startedAt = Date.now();
  sseSend(res, "log", {
    label: "准备请求",
    model: payload.model,
    toolModel: payload.tools[0].model,
    size: payload.tools[0].size || "auto",
    quality: payload.tools[0].quality,
    format,
    quota: reservation.quota,
  });

  try {
    const upstream = await fetch(buildApiUrl(cfg.baseUrl, "responses"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
        "Accept": payload.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const raw = await upstream.text();
      let message = raw.slice(0, 1200);
      try {
        const json = JSON.parse(raw);
        message = json?.error?.message || json?.message || JSON.stringify(json).slice(0, 1200);
      } catch {}
      refundGenerationCredit(reservation, message || `HTTP ${upstream.status}`);
      sseSend(res, "error", { status: upstream.status, message });
      res.end();
      return;
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") || !upstream.body) {
      const data = await upstream.json();
      const image = extractImage(data);
      if (!image) {
        refundGenerationCredit(reservation, "API 返回成功，但没有找到图片数据");
        sseSend(res, "error", { message: "API 返回成功，但没有找到图片数据" });
      } else {
        const usage = extractUsage(data);
        const quota = commitGenerationCredit(reservation, { usage, elapsedMs: Date.now() - startedAt, format });
        sseSend(res, "result", { image, usage, elapsedMs: Date.now() - startedAt, format, quota });
      }
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let latestImage = null;
    let latestUsage = null;
    let finalResponse = null;
    let failedMessage = "";
    let eventCount = 0;
    keepaliveTimer = setInterval(() => {
      sseSend(res, "log", { label: "连接保持中", type: "keepalive", elapsedMs: Date.now() - startedAt });
    }, 25000);

    const flush = (raw) => {
      const event = parseSseEvent(raw);
      if (!event) return;
      eventCount += 1;
      const { type, data } = event;
      if (failedMessage) return;
      if (data?.error) {
        failedMessage = data.error.message || String(data.error);
        sseSend(res, "error", { message: failedMessage });
        return;
      }
      if (type === "response.failed") {
        failedMessage = data?.response?.error?.message || data?.error?.message || "上游生成失败";
        sseSend(res, "error", { message: failedMessage });
        return;
      }
      const image = extractImage(data);
      if (image) latestImage = image;
      const usage = extractUsage(data);
      if (usage) latestUsage = usage;
      if (data?.response) finalResponse = data.response;
      if (type === "response.completed") finalResponse = data.response || data;
      const partial = typeof data?.partial_image_b64 === "string" ? data.partial_image_b64 : null;
      sseSend(res, "progress", {
        type,
        label: eventLabel(type, data),
        eventCount,
        partial,
        partialIndex: typeof data?.partial_image_index === "number" ? data.partial_image_index : null,
        elapsedMs: Date.now() - startedAt,
      });
    };

    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";
      for (const part of parts) flush(part);
    }
    if (buffer.trim()) flush(buffer);
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;

    if (failedMessage) {
      refundGenerationCredit(reservation, failedMessage);
      res.end();
      return;
    }
    if (!latestImage && finalResponse) {
      latestImage = extractImage(finalResponse);
      latestUsage = latestUsage || extractUsage(finalResponse);
    }
    if (!latestImage) {
      refundGenerationCredit(reservation, "流结束，但未能提取图片数据");
      sseSend(res, "error", { message: "流结束，但未能提取图片数据" });
    } else {
      const quota = commitGenerationCredit(reservation, { usage: latestUsage, elapsedMs: Date.now() - startedAt, format });
      sseSend(res, "result", { image: latestImage, usage: latestUsage, elapsedMs: Date.now() - startedAt, format, quota });
    }
    res.end();
  } catch (error) {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    refundGenerationCredit(reservation, error?.message || String(error));
    if (error?.name === "AbortError") return;
    sseSend(res, "error", { message: error?.message || String(error) });
    res.end();
  }
}

function chatContentText(content) {
  if (Array.isArray(content)) return content.map((item) => typeof item === "string" ? item : item.text || "").join("");
  return String(content || "");
}

function cleanModelResponseText(text) {
  return String(text || "")
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/\n?```$/, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

async function enhancePrompt(req, res) {
  const input = await readJson(req);
  const cfg = getRuntimeConfig(input || {});
  if (!cfg.apiKey) {
    sendJson(res, 400, { error: "missing API key in env" });
    return;
  }
  const system = [
    '你是面向图像模型 "gpt-image-2" 的提示词优化助手。这个模型适合自然语言画面描述，不适合逗号堆叠的 Stable Diffusion 标签。',
    "把用户想法改写成一段清晰、生动、可直接用于生成图片的中文自然语言提示词。",
    "必须使用简体中文输出，即使用户输入是英文或中英混合；但要保留用户指定的主体、意图、数字、@name 标记、专有名词和明确不可翻译的名称。",
    "补充有用的具体细节：场景、构图、光线、材质、镜头角度、情绪、色彩、纹理和关键道具。",
    "不要输出 <think> 标签、推理过程、分析过程或英文说明。",
    "只输出优化后的提示词正文，不要 Markdown，不要引号，不要解释。",
  ].join("\n");
  try {
    const upstream = await fetch(buildApiUrl(cfg.baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.enhanceModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: String(input.prompt || "") },
        ],
        temperature: 0.7,
        stream: false,
      }),
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      let message = raw.slice(0, 800);
      try {
        const json = JSON.parse(raw);
        message = json?.error?.message || json?.message || message;
      } catch {}
      sendJson(res, upstream.status, { error: message });
      return;
    }
    const data = JSON.parse(raw);
    const text = cleanModelResponseText(chatContentText(data?.choices?.[0]?.message?.content));
    sendJson(res, 200, { prompt: text, model: cfg.enhanceModel });
  } catch (error) {
    sendJson(res, 500, { error: error?.message || String(error) });
  }
}

function parseStoryboardJson(text) {
  const raw = cleanModelResponseText(text);
  try {
    return JSON.parse(raw);
  } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(raw.slice(start, end + 1));
  }
  throw new Error("storyboard response is not valid JSON");
}

function normalizeStoryboard(data, count) {
  const frames = Array.isArray(data?.frames) ? data.frames : Array.isArray(data?.panels) ? data.panels : [];
  return frames.slice(0, count).map((frame, index) => ({
    index: index + 1,
    title: String(frame?.title || `画面 ${index + 1}`).trim(),
    beat: String(frame?.beat || frame?.summary || frame?.plot || "").trim(),
    prompt: String(frame?.prompt || frame?.description || "").trim(),
  })).filter((frame) => frame.prompt);
}

function normalizeStoryboardAnchors(data, fallback = {}) {
  const direct = Array.isArray(data?.anchors) ? data.anchors : Array.isArray(data?.coreAssets) ? data.coreAssets : [];
  const grouped = [
    ...(Array.isArray(data?.characters) ? data.characters.map((item) => ({ ...item, type: item?.type || "character" })) : []),
    ...(Array.isArray(data?.objects) ? data.objects.map((item) => ({ ...item, type: item?.type || "object" })) : []),
    ...(Array.isArray(data?.locations) ? data.locations.map((item) => ({ ...item, type: item?.type || "location" })) : []),
    ...(Array.isArray(data?.themes) ? data.themes.map((item) => ({ ...item, type: item?.type || "theme" })) : []),
  ];
  const typeMap = {
    character: "character",
    role: "character",
    person: "character",
    object: "object",
    prop: "object",
    item: "object",
    location: "location",
    scene: "location",
    place: "location",
    theme: "theme",
    motif: "theme",
    style: "theme",
  };
  const anchors = [...direct, ...grouped].map((item, index) => {
    const rawType = String(item?.type || item?.category || "").trim().toLowerCase();
    const type = typeMap[rawType] || "theme";
    const name = String(item?.name || item?.title || `核心设定 ${index + 1}`).trim();
    const description = String(item?.description || item?.desc || item?.summary || "").trim();
    const visualLock = String(item?.visualLock || item?.lock || item?.prompt || item?.constraint || "").trim();
    return { type, name, description, visualLock };
  }).filter((item) => item.name && (item.description || item.visualLock));
  if (anchors.length) return anchors.slice(0, 8);
  return [{
    type: "theme",
    name: "整体连续性",
    description: fallback.style || fallback.story || "连续画面的统一视觉设定",
    visualLock: fallback.continuity || "所有画面保持同一人物、服饰、核心道具、场景线索、光线和色调连续。",
  }];
}

async function buildStoryboard(req, res) {
  const input = await readJson(req);
  const cfg = getRuntimeConfig(input || {});
  if (!cfg.apiKey) {
    sendJson(res, 400, { error: "missing API key in env" });
    return;
  }
  const count = Math.max(1, Math.min(24, Number(input.count || 6)));
  const style = String(input.style || "电影感").trim();
  const story = String(input.story || "").trim();
  const continuity = String(input.continuity || "").trim();
  const userAnchors = Array.isArray(input.anchors) ? input.anchors : [];
  const userAnchorText = userAnchors.map((anchor, index) => {
    const name = String(anchor?.name || `核心设定 ${index + 1}`).trim();
    const type = String(anchor?.type || "theme").trim();
    const description = String(anchor?.description || "").trim();
    const visualLock = String(anchor?.visualLock || "").trim();
    return `${index + 1}. [${type}] ${name}: ${description}${visualLock ? `；视觉锁定：${visualLock}` : ""}`;
  }).filter(Boolean).join("\n");
  if (!story) {
    sendJson(res, 400, { error: "story is required" });
    return;
  }
  const system = [
    "You are a senior visual storyboard designer and image prompt writer.",
    "First design stable continuity anchors, then expand the user's story into a coherent sequence of image-generation frames.",
    "Continuity anchors are recurring characters, key objects, important locations, or visual themes that must stay consistent across every generated image.",
    "Each frame must follow the previous frame logically and preserve the anchors exactly: character appearance, clothing, props, setting details, color palette, and lighting direction.",
    "Write prompts as natural-language image descriptions, not comma-separated tag lists.",
    "Do not output <think> tags, reasoning, analysis, or any text outside the JSON object.",
    "Return strict JSON only. No markdown.",
    'Schema: {"title":"短标题","anchors":[{"type":"character|object|location|theme","name":"名称","description":"固定设定","visualLock":"每张图必须遵守的视觉锁定描述"}],"frames":[{"title":"短标题","beat":"剧情节点","prompt":"适合图像生成的自然语言画面描述"}]}',
  ].join("\n");
  const user = [
    `剧情：${story}`,
    `出图张数：${count}`,
    `视觉风格：${style || "自由发挥"}`,
    continuity ? `连续性要求：${continuity}` : "",
    userAnchorText ? `用户已指定的核心设定：\n${userAnchorText}` : "",
    "要求：",
    "- 先创建 3 到 8 个 anchors，至少包含主要角色；如果剧情没有人物，则包含核心对象、地点或主题。",
    "- 如果用户已指定核心设定，必须保留这些设定，只能补充更精确的视觉锁定细节。",
    "- anchors 必须具体到外观、服装、材质、颜色、标志性细节、比例、环境或色调，不要写抽象词。",
    "- 每一帧 prompt 必须显式引用相关 anchors 的稳定特征，避免人物、对象或主题漂移。",
    "- 每一帧必须是独立可生成的完整画面描述。",
    "- 每帧都包含主体、动作、环境、构图、光线、镜头、情绪和必要的连续性信息。",
    "- 不要生成暴力血腥、色情或违法内容。",
    `- 严格返回 ${count} 个 frames。`,
  ].filter(Boolean).join("\n");
  try {
    const upstream = await fetch(buildApiUrl(cfg.baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.enhanceModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.65,
        stream: false,
      }),
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      let message = raw.slice(0, 800);
      try {
        const json = JSON.parse(raw);
        message = json?.error?.message || json?.message || message;
      } catch {}
      sendJson(res, upstream.status, { error: message });
      return;
    }
    const data = JSON.parse(raw);
    const content = chatContentText(data?.choices?.[0]?.message?.content);
    const parsed = parseStoryboardJson(content);
    const frames = normalizeStoryboard(parsed, count);
    const anchors = normalizeStoryboardAnchors(parsed, { story, style, continuity });
    if (!frames.length) {
      sendJson(res, 502, { error: "model returned no usable frames" });
      return;
    }
    sendJson(res, 200, {
      title: String(parsed?.title || "连续出图").trim(),
      anchors,
      frames,
      model: cfg.enhanceModel,
    });
  } catch (error) {
    sendJson(res, 500, { error: error?.message || String(error) });
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestPath = normalizeRequestPath(url.pathname);
  try {
    if (req.method === "GET" && requestPath === "/api/auth/me") {
      sendAuthMe(req, res);
      return;
    }
    if (req.method === "POST" && requestPath === "/api/auth/register/send-code") {
      await sendAuthCode(req, res, "register");
      return;
    }
    if (req.method === "POST" && requestPath === "/api/auth/register/verify") {
      await verifyRegistration(req, res);
      return;
    }
    if (req.method === "POST" && requestPath === "/api/auth/login/send-code") {
      await sendAuthCode(req, res, "login");
      return;
    }
    if (req.method === "POST" && requestPath === "/api/auth/login/verify") {
      await verifyLogin(req, res);
      return;
    }
    if (req.method === "POST" && requestPath === "/api/auth/logout") {
      logout(req, res);
      return;
    }
    if (req.method === "GET" && requestPath === "/api/config") {
      const cfg = getRuntimeConfig();
      sendJson(res, 200, {
        hasKey: Boolean(cfg.apiKey),
        apiBase: cfg.baseUrl,
        imageModel: cfg.imageModel,
        defaultModel: DEFAULT_IMAGE_MODEL,
        toolModel: cfg.toolModel,
        enhanceModel: cfg.enhanceModel,
        models: IMAGE_MODEL_OPTIONS,
        enhanceModels: ENHANCE_MODEL_OPTIONS,
      });
      return;
    }
    if (req.method === "GET" && requestPath === "/api/data/bootstrap") {
      const user = requireCurrentUser(req);
      sendJson(res, 200, bootstrapData(url.searchParams.get("projectId") || DEFAULT_PROJECT_ID, user));
      return;
    }
    if (req.method === "POST" && requestPath === "/api/data/bootstrap") {
      const user = requireCurrentUser(req);
      const input = await readJson(req);
      const projectId = input.projectId || DEFAULT_PROJECT_ID;
      const stores = input.stores && typeof input.stores === "object" ? input.stores : {};
      const resolvedProjectId = resolveProjectIdForUser(user, projectId);
      for (const store of DATA_STORES) {
        const records = Array.isArray(stores[store]) ? stores[store] : [];
        for (const record of records) {
          putRecord(store, store === "projects" ? record : { ...record, projectId: resolvedProjectId }, user);
        }
      }
      sendJson(res, 200, bootstrapData(resolvedProjectId, user));
      return;
    }
    const dataStoreMatch = requestPath.match(/^\/api\/data\/([^/]+)(?:\/([^/]+))?$/);
    if (dataStoreMatch) {
      const user = requireCurrentUser(req);
      const store = dataStoreMatch[1];
      const id = dataStoreMatch[2] ? decodeURIComponent(dataStoreMatch[2]) : "";
      if (!DATA_STORES.has(store)) {
        sendJson(res, 404, { error: "unknown data store" });
        return;
      }
      if (req.method === "GET") {
        sendJson(res, 200, { items: listRecords(store, url.searchParams.get("projectId") || "", user) });
        return;
      }
      if (req.method === "POST") {
        const record = await readJson(req);
        sendJson(res, 200, { item: putRecord(store, record, user) });
        return;
      }
      if (req.method === "DELETE" && id) {
        deleteRecord(store, id, user);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "DELETE") {
        clearRecords(store, url.searchParams.get("projectId") || "", user);
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    if (req.method === "GET" && requestPath === "/api/admin/storage/overview") {
      const user = requireCurrentUser(req);
      if (!isGlobalAdmin(user)) throw new HttpError(403, "需要管理员权限", "admin_required");
      sendJson(res, 200, storageOverview());
      return;
    }
    if (req.method === "GET" && requestPath === "/api/admin/users") {
      const user = requireCurrentUser(req);
      if (!isGlobalAdmin(user)) throw new HttpError(403, "需要管理员权限", "admin_required");
      sendJson(res, 200, adminUsersOverview());
      return;
    }
    const adminUserMatch = requestPath.match(/^\/api\/admin\/users\/([^/]+)(?:\/([^/]+))?$/);
    if (adminUserMatch) {
      const user = requireCurrentUser(req);
      if (!isGlobalAdmin(user)) throw new HttpError(403, "需要管理员权限", "admin_required");
      const targetUserId = decodeURIComponent(adminUserMatch[1]);
      const action = adminUserMatch[2] ? decodeURIComponent(adminUserMatch[2]) : "";
      if (req.method === "GET" && action === "overview") {
        sendJson(res, 200, { user: adminUserDetail(targetUserId) });
        return;
      }
      if (req.method === "POST" && action === "quota") {
        const input = await readJson(req);
        sendJson(res, 200, { user: updateUserQuota(targetUserId, input, user) });
        return;
      }
    }
    if (req.method === "POST" && requestPath === "/api/generation-tasks") {
      const user = requireCurrentUser(req);
      await createGenerationTask(req, res, user);
      return;
    }
    const generationTaskMatch = requestPath.match(/^\/api\/generation-tasks\/([^/]+)(?:\/([^/]+))?$/);
    if (generationTaskMatch) {
      const user = requireCurrentUser(req);
      const taskId = decodeURIComponent(generationTaskMatch[1]);
      const action = generationTaskMatch[2] ? decodeURIComponent(generationTaskMatch[2]) : "";
      if (req.method === "GET" && !action) {
        getGenerationTask(req, res, user, taskId);
        return;
      }
      if (req.method === "POST" && action === "cancel") {
        cancelGenerationTask(req, res, user, taskId);
        return;
      }
    }
    const generatedFileMatch = requestPath.match(/^\/api\/generated\/(.+)$/);
    if ((req.method === "GET" || req.method === "HEAD") && generatedFileMatch) {
      const user = requireCurrentUser(req);
      await serveGeneratedFile(req, res, user, decodeURIComponent(generatedFileMatch[1]));
      return;
    }
    if (req.method === "POST" && requestPath === "/api/generate") {
      const user = requireCurrentUser(req);
      await proxyGenerate(req, res, user);
      return;
    }
    if (req.method === "POST" && requestPath === "/api/enhance") {
      requireCurrentUser(req);
      await enhancePrompt(req, res);
      return;
    }
    if (req.method === "POST" && requestPath === "/api/storyboard") {
      requireCurrentUser(req);
      await buildStoryboard(req, res);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      let path = decodeURIComponent(requestPath);
      if (path === "/") path = "/index.html";
      const filePath = resolve(publicDir, `.${path}`);
      if (!filePath.startsWith(publicDir)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      const data = req.method === "HEAD" ? null : await readFile(filePath);
      res.writeHead(200, { "Content-Type": mimeType(filePath) });
      res.end(data);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (error instanceof HttpError || error?.status) {
      sendJson(res, Number(error.status || 500), { error: error.message || "请求失败", code: error.code || "" });
      return;
    }
    sendJson(res, 500, { error: error?.message || String(error) });
  }
}

initializeStorage();
recoverInterruptedGenerationTasks();

const server = createServer(route);
server.listen(defaultPort, () => {
  console.log(`Image creation workbench running at http://localhost:${defaultPort}`);
});
