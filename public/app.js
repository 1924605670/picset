const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const DB_NAME = "ImageCreationWorkbench";
const DB_VERSION = 2;
const DEFAULT_PROJECT_ID = "project_default";
const STANDARD_IMAGE_MODEL = "gpt-image-2-chat";
const DEFAULT_ENHANCE_MODEL = "deepseek-v4-pro";
const stores = ["projects", "conversations", "messages", "gallery", "galleryFolders", "favorites", "assets"];
const state = {
  db: null,
  config: null,
  auth: {
    user: null,
    mode: "login",
    emailSent: false,
    pendingEmail: "",
    cooldownUntil: 0,
    cooldownTimer: null,
    resendConfigured: false,
    authRequired: true,
    busy: "",
  },
  settings: {
    apiBase: "",
    model: STANDARD_IMAGE_MODEL,
    enhanceModel: DEFAULT_ENHANCE_MODEL,
    timeoutMs: 0,
    retries: 1,
  },
  admin: {
    users: [],
    overview: null,
    selectedUserId: "",
    selectedUser: null,
    busy: false,
  },
  projects: [],
  currentProjectId: localStorage.getItem("picsetCurrentProjectId") || DEFAULT_PROJECT_ID,
  conversations: [],
  messages: [],
  gallery: [],
  galleryFolders: [],
  favorites: [],
  assets: [],
  activeGalleryFolderId: "all",
  currentConversationId: null,
  pendingImages: [],
  activeTasks: new Map(),
  galleryPick: new Set(),
  folderPickContext: null,
  editContext: null,
  storyboard: { title: "", anchors: [], frames: [], run: null, busy: "" },
  mark: null,
};

const examples = [
  "一只白色小猫坐在窗边，清晨柔和阳光洒进房间，写实摄影风格，浅景深，温暖安静的氛围",
  "未来城市屋顶花园，雨后霓虹反光，电影感广角构图，高细节",
  "一张高级杂志广告图：透明玻璃香水瓶放在石材台面，侧逆光，柔和阴影",
  "日漫风少女站在海边车站，夏日黄昏，风吹起校服裙摆，远处有列车灯光"
];

const MODEL_LABELS = {
  [STANDARD_IMAGE_MODEL]: { name: "标准生成", desc: "默认通道 · 适合日常草稿" },
};

const MODEL_OPTIONS = [
  { id: STANDARD_IMAGE_MODEL, name: "标准生成", desc: "默认通道 · 适合日常草稿", premium: false },
];

const ENHANCE_MODEL_LABELS = {
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", desc: "当前默认 · 适合中文提示词优化和剧情拆帧" },
  "MiniMax-M3": { name: "MiniMax-M3", desc: "备选 LLM · 适合长文本规划和中文创作" },
};

const ENHANCE_MODEL_OPTIONS = [
  { id: "deepseek-v4-pro", ...ENHANCE_MODEL_LABELS["deepseek-v4-pro"] },
  { id: "MiniMax-M3", ...ENHANCE_MODEL_LABELS["MiniMax-M3"] },
];

const ANCHOR_TYPES = [
  { id: "character", name: "角色" },
  { id: "object", name: "对象" },
  { id: "location", name: "地点" },
  { id: "theme", name: "主题" },
];

const STORYBOARD_REFERENCE_TEXT = "生成核心参考图";
const STORYBOARD_START_TEXT = "继续生成剧情图";

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return Date.now();
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[ch]);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function imageMime(format) {
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function normalizeImageRef(image, format = "png") {
  if (!image) return "";
  const ref = String(image);
  if (/^(data:|https?:\/\/|blob:|\/|api\/|\.\/|\.\.\/)/i.test(ref)) return ref;
  return `data:${imageMime(format)};base64,${ref.replace(/\s+/g, "")}`;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove("show"), 2200);
}

function setAuthStatus(message, tone = "") {
  const el = $("#auth-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = `auth-status ${tone || ""}`.trim();
}

function showAuthenticatedApp(show) {
  $("#auth-gate")?.classList.toggle("hidden", show);
  $("#app-shell")?.classList.toggle("hidden", !show);
}

function isGlobalAdminUser(user = state.auth.user) {
  return user?.role === "owner" || user?.role === "admin";
}

function quotaDisplay(quota) {
  if (!quota) return "额度 --";
  if (quota.unlimited || Number(quota.total) < 0) return `已用 ${Number(quota.used || 0)} · 不限量`;
  return `剩余 ${Number(quota.remaining || 0)}/${Number(quota.total || 0)}`;
}

function renderAccount() {
  const user = state.auth.user;
  const name = user?.displayName || user?.username || user?.email || "未登录";
  const el = $("#account-name");
  if (el) el.textContent = name;
  const quota = $("#quota-chip");
  if (quota) {
    quota.textContent = quotaDisplay(user?.quota);
    quota.classList.toggle("hidden", !user);
    quota.classList.toggle("empty", Boolean(user?.quota && !user.quota.unlimited && Number(user.quota.remaining || 0) <= 0));
  }
  $("#open-admin-btn")?.classList.toggle("hidden", !isGlobalAdminUser(user));
}

function authEmail() {
  return $("#auth-email")?.value.trim().toLowerCase() || "";
}

function renderAuthForm() {
  const isRegister = state.auth.mode === "register";
  $$(".auth-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.authMode === state.auth.mode));
  $("#auth-register-fields")?.classList.toggle("hidden", !isRegister);
  $$(".auth-code-row").forEach((el) => el.classList.toggle("hidden", !state.auth.emailSent));
  const submit = $("#auth-submit-btn");
  if (submit) submit.textContent = isRegister ? "完成注册" : "完成登录";
  updateAuthSendButton();
}

function updateAuthSendButton() {
  const btn = $("#auth-send-code-btn");
  if (!btn) return;
  const remaining = Math.max(0, Math.ceil((state.auth.cooldownUntil - Date.now()) / 1000));
  const busy = Boolean(state.auth.busy);
  btn.disabled = busy || remaining > 0;
  if (state.auth.busy === "send") btn.textContent = "发送中";
  else if (remaining > 0) btn.textContent = `${remaining} 秒后重发`;
  else btn.textContent = "发送验证码";
}

function clearAuthCooldown() {
  state.auth.cooldownUntil = 0;
  clearInterval(state.auth.cooldownTimer);
  state.auth.cooldownTimer = null;
  updateAuthSendButton();
}

function startAuthCooldown(seconds = 60) {
  state.auth.cooldownUntil = Date.now() + Number(seconds || 60) * 1000;
  clearInterval(state.auth.cooldownTimer);
  state.auth.cooldownTimer = setInterval(() => {
    updateAuthSendButton();
    if (Date.now() >= state.auth.cooldownUntil) {
      clearInterval(state.auth.cooldownTimer);
      state.auth.cooldownTimer = null;
      updateAuthSendButton();
    }
  }, 500);
  updateAuthSendButton();
}

function setAuthMode(mode) {
  state.auth.mode = mode === "register" ? "register" : "login";
  state.auth.emailSent = false;
  state.auth.pendingEmail = "";
  state.auth.busy = "";
  clearAuthCooldown();
  $("#auth-code").value = "";
  setAuthStatus(state.auth.mode === "register" ? "输入邮箱并接收验证码创建账号。" : "输入已注册邮箱并接收登录验证码。");
  renderAuthForm();
}

async function readApiJson(res, fallback = "请求失败") {
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) {
    handleAuthExpired(data.error || "登录状态已失效，请重新登录");
  }
  if (!res.ok) throw new Error(data.error || fallback);
  return data;
}

async function authPost(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readApiJson(res, "认证请求失败");
}

async function sendAuthCode() {
  const email = authEmail();
  if (!email) {
    setAuthStatus("请输入邮箱", "error");
    return;
  }
  state.auth.busy = "send";
  updateAuthSendButton();
  setAuthStatus("正在发送验证码...");
  try {
    const path = state.auth.mode === "register" ? "api/auth/register/send-code" : "api/auth/login/send-code";
    const data = await authPost(path, { email });
    state.auth.emailSent = true;
    state.auth.pendingEmail = email;
    startAuthCooldown(data.cooldownSeconds || 60);
    const devText = data.devCode ? `开发验证码：${data.devCode}` : "验证码已发送，请查看邮箱。";
    setAuthStatus(devText, "ok");
    renderAuthForm();
    $("#auth-code")?.focus();
  } catch (error) {
    setAuthStatus(error.message || "验证码发送失败", "error");
  } finally {
    state.auth.busy = "";
    updateAuthSendButton();
  }
}

async function submitAuthCode() {
  const email = authEmail();
  const code = $("#auth-code")?.value.trim() || "";
  if (!email || !/^\d{6}$/.test(code)) {
    setAuthStatus("请输入邮箱和 6 位验证码", "error");
    return;
  }
  state.auth.busy = "verify";
  $("#auth-submit-btn").disabled = true;
  setAuthStatus(state.auth.mode === "register" ? "正在创建账号..." : "正在登录...");
  try {
    const isRegister = state.auth.mode === "register";
    const path = isRegister ? "api/auth/register/verify" : "api/auth/login/verify";
    const payload = {
      email,
      code,
      username: $("#auth-username")?.value.trim() || "",
      displayName: $("#auth-display-name")?.value.trim() || "",
    };
    const data = await authPost(path, payload);
    await completeAuth(data);
  } catch (error) {
    setAuthStatus(error.message || "验证码校验失败", "error");
  } finally {
    state.auth.busy = "";
    $("#auth-submit-btn").disabled = false;
    updateAuthSendButton();
  }
}

function resetWorkspaceState() {
  for (const task of state.activeTasks.values()) {
    if (typeof task?.abort === "function") task.abort();
    else task?.controller?.abort?.();
  }
  state.projects = [];
  state.conversations = [];
  state.messages = [];
  state.gallery = [];
  state.galleryFolders = [];
  state.favorites = [];
  state.assets = [];
  state.pendingImages = [];
  state.activeTasks.clear();
  state.currentProjectId = DEFAULT_PROJECT_ID;
  state.currentConversationId = null;
  state.activeGalleryFolderId = "all";
  state.admin = { users: [], overview: null, selectedUserId: "", selectedUser: null, busy: false };
  localStorage.removeItem("picsetCurrentProjectId");
  resetStoryboardStateOnly();
}

function handleAuthExpired(message = "登录状态已失效，请重新登录") {
  state.auth.user = null;
  resetWorkspaceState();
  showAuthenticatedApp(false);
  renderAccount();
  setAuthStatus(message, "error");
  renderAuthForm();
}

async function completeAuth(data) {
  state.auth.user = data.user || null;
  state.auth.emailSent = false;
  state.auth.pendingEmail = "";
  clearAuthCooldown();
  $("#auth-code").value = "";
  if (data.defaultProjectId) {
    state.currentProjectId = data.defaultProjectId;
    localStorage.setItem("picsetCurrentProjectId", state.currentProjectId);
  }
  showAuthenticatedApp(true);
  renderAccount();
  await loadWorkspaceAfterAuth();
}

async function initAuth() {
  try {
    const res = await fetch("api/auth/me");
    const data = await readApiJson(res, "登录状态检查失败");
    state.auth.user = data.user || null;
    state.auth.resendConfigured = Boolean(data.resendConfigured);
    state.auth.authRequired = data.authRequired !== false;
    if (data.defaultProjectId) {
      state.currentProjectId = data.defaultProjectId;
      localStorage.setItem("picsetCurrentProjectId", state.currentProjectId);
    }
    if (data.authenticated && data.user) {
      showAuthenticatedApp(true);
      renderAccount();
      return true;
    }
    showAuthenticatedApp(false);
    renderAccount();
    setAuthMode("login");
    const hint = data.resendConfigured || data.devAuthCode
      ? "输入邮箱接收验证码后进入工作区。"
      : "服务端还未配置 RESEND_API_KEY 和 RESEND_FROM。";
    setAuthStatus(hint, data.resendConfigured || data.devAuthCode ? "" : "error");
    return false;
  } catch (error) {
    showAuthenticatedApp(false);
    setAuthStatus(error.message || "登录状态检查失败", "error");
    renderAuthForm();
    return false;
  }
}

async function loadWorkspaceAfterAuth() {
  await loadAll();
  await initConfig();
  renderAll();
  updateParamSummary();
  resumePendingGenerationTasks();
}

function resumePendingGenerationTasks() {
  for (const msg of state.messages) {
    if (msg.status === "pending" && msg.taskId && !state.activeTasks.has(msg.id)) {
      runGeneration(msg.id);
    }
  }
}

async function logoutCurrentUser() {
  try {
    await fetch("api/auth/logout", { method: "POST" });
  } catch {}
  state.auth.user = null;
  resetWorkspaceState();
  showAuthenticatedApp(false);
  renderAccount();
  setAuthMode("login");
  setAuthStatus("已退出登录。");
}

function openLegacyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of stores) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: "id" });
          if (name === "messages") store.createIndex("conversationId", "conversationId", { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function legacyTxStore(db, name, mode = "readonly") {
  return db.transaction(name, mode).objectStore(name);
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(store, value) {
  const record = withProject(store, value);
  const res = await fetch(`api/data/${encodeURIComponent(store)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  const data = await readApiJson(res, "保存失败");
  return data.item;
}

async function del(store, id) {
  const res = await fetch(`api/data/${encodeURIComponent(store)}/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await readApiJson(res, "删除失败");
  return data;
}

async function getAll(store) {
  const url = store === "projects"
    ? `api/data/${encodeURIComponent(store)}`
    : `api/data/${encodeURIComponent(store)}?projectId=${encodeURIComponent(state.currentProjectId)}`;
  const res = await fetch(url);
  const data = await readApiJson(res, "读取失败");
  return data.items || [];
}

async function clearStore(store) {
  const projectParam = store === "projects" ? "" : `?projectId=${encodeURIComponent(state.currentProjectId)}`;
  const res = await fetch(`api/data/${encodeURIComponent(store)}${projectParam}`, { method: "DELETE" });
  const data = await readApiJson(res, "清空失败");
  return data;
}

function withProject(store, value) {
  if (store === "projects") return value;
  return { ...value, projectId: value.projectId || state.currentProjectId || DEFAULT_PROJECT_ID };
}

async function legacyGetAll(db, store) {
  if (!db.objectStoreNames.contains(store)) return [];
  return idbRequest(legacyTxStore(db, store).getAll());
}

async function migrateLegacyIndexedDbIfNeeded(snapshot) {
  if (localStorage.getItem("picsetSqliteMigrationDone") === "1") return snapshot;
  const hasServerData = ["conversations", "messages", "gallery", "galleryFolders", "favorites", "assets"]
    .some((store) => (snapshot[store] || []).length > 0);
  if (hasServerData) {
    localStorage.setItem("picsetSqliteMigrationDone", "1");
    return snapshot;
  }
  let legacyDb = null;
  try {
    legacyDb = await openLegacyDb();
    const legacyStores = {};
    let legacyCount = 0;
    for (const store of ["conversations", "messages", "gallery", "galleryFolders", "favorites", "assets"]) {
      legacyStores[store] = (await legacyGetAll(legacyDb, store)).map((item) => withProject(store, item));
      legacyCount += legacyStores[store].length;
    }
    if (!legacyCount) {
      localStorage.setItem("picsetSqliteMigrationDone", "1");
      return snapshot;
    }
    const res = await fetch("api/data/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: state.currentProjectId || DEFAULT_PROJECT_ID, stores: legacyStores }),
    });
    const data = await readApiJson(res, "旧数据迁移失败");
    localStorage.setItem("picsetSqliteMigrationDone", "1");
    toast(`已迁移 ${legacyCount} 条旧本地数据到 SQLite`);
    return data;
  } catch (error) {
    console.warn(error);
    toast(error.message || "旧数据迁移失败");
    return snapshot;
  } finally {
    legacyDb?.close?.();
  }
}

async function loadAll() {
  const res = await fetch(`api/data/bootstrap?projectId=${encodeURIComponent(state.currentProjectId || DEFAULT_PROJECT_ID)}`);
  let snapshot = await readApiJson(res, "读取工作区失败");
  snapshot = await migrateLegacyIndexedDbIfNeeded(snapshot);
  state.projects = (snapshot.projects || []).filter((item) => !item.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!state.projects.some((project) => project.id === state.currentProjectId)) {
    state.currentProjectId = state.projects[0]?.id || snapshot.defaultProjectId || DEFAULT_PROJECT_ID;
    localStorage.setItem("picsetCurrentProjectId", state.currentProjectId);
    if (state.currentProjectId !== snapshot.defaultProjectId) return loadAll();
  }
  state.conversations = (snapshot.conversations || []).sort((a, b) => b.updatedAt - a.updatedAt);
  state.messages = (snapshot.messages || []).sort((a, b) => a.createdAt - b.createdAt);
  state.gallery = (snapshot.gallery || []).sort((a, b) => b.createdAt - a.createdAt);
  state.galleryFolders = (snapshot.galleryFolders || []).sort((a, b) => a.createdAt - b.createdAt);
  state.favorites = (snapshot.favorites || []).sort((a, b) => b.createdAt - a.createdAt);
  state.assets = (snapshot.assets || []).sort((a, b) => b.createdAt - a.createdAt);
  if (!state.conversations.length) await createConversation();
  else state.currentConversationId = state.conversations[0].id;
}

async function createConversation(title = "新创作") {
  const conv = { id: uid("conv"), projectId: state.currentProjectId, title, createdAt: now(), updatedAt: now() };
  const saved = await put("conversations", conv);
  state.conversations.unshift(saved);
  state.currentConversationId = saved.id;
  state.pendingImages = [];
  renderAll();
  return saved;
}

async function updateConversation(convId, patch) {
  const conv = state.conversations.find((item) => item.id === convId);
  if (!conv) return;
  Object.assign(conv, patch, { updatedAt: now() });
  await put("conversations", conv);
  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  renderConversationList();
}

async function addMessage(message) {
  const record = { ...message, projectId: message.projectId || state.currentProjectId, id: message.id || uid("msg"), createdAt: message.createdAt || now() };
  const saved = await put("messages", record);
  state.messages.push(saved);
  await updateConversation(saved.conversationId, {});
  return saved;
}

async function updateMessage(id, patch) {
  const msg = state.messages.find((item) => item.id === id);
  if (!msg) return;
  Object.assign(msg, patch);
  await put("messages", msg);
}

function currentMessages() {
  return state.messages.filter((msg) => msg.conversationId === state.currentConversationId);
}

function getParams() {
  const size = $("#param-size").value;
  const quality = $("#param-quality").value;
  const format = $("#param-format").value;
  const reasoning = $("#param-reasoning").value;
  return { size, quality, format, reasoning };
}

function getSeed() {
  const active = $(".seed-option.active");
  if (active && active.dataset.seed !== "custom") return Number(active.dataset.seed || 0);
  const custom = Number($("#custom-seed").value || 0);
  return Number.isFinite(custom) && custom > 0 ? Math.floor(custom) : 0;
}

function renderAll() {
  renderProjects();
  renderConversationList();
  renderChat();
  renderFolderList();
  renderGallery();
  renderFavorites();
  renderAssets();
  renderPendingImages();
  renderModelMenu();
}

function currentProject() {
  return state.projects.find((project) => project.id === state.currentProjectId) || state.projects[0] || null;
}

function renderProjects() {
  const select = $("#project-select");
  if (!select) return;
  select.innerHTML = "";
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name || "未命名项目";
    select.appendChild(option);
  }
  select.value = state.currentProjectId;
  renderProjectList();
}

function renderProjectList() {
  const list = $("#project-list");
  if (!list) return;
  list.innerHTML = "";
  for (const project of state.projects) {
    const row = document.createElement("div");
    row.className = `project-row ${project.id === state.currentProjectId ? "active" : ""}`;
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(project.name || "未命名项目")}</strong>
        <span>${escapeHtml(project.description || "暂无说明")}</span>
      </div>
      <div class="project-row-actions">
        <button class="ghost-mini" data-switch-project="${project.id}" type="button">切换</button>
        <button class="ghost-mini" data-rename-project="${project.id}" type="button">载入</button>
      </div>
    `;
    $("[data-switch-project]", row).onclick = () => switchProject(project.id);
    $("[data-rename-project]", row).onclick = () => loadProjectIntoForm(project.id);
    list.appendChild(row);
  }
}

function loadProjectIntoForm(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  $("#project-name-input").value = project.name || "";
  $("#project-desc-input").value = project.description || "";
  $("#save-project-btn").dataset.editProjectId = project.id;
  $("#save-project-btn").textContent = "保存项目";
}

async function saveProjectFromModal() {
  const name = $("#project-name-input").value.trim();
  const description = $("#project-desc-input").value.trim();
  if (!name) {
    toast("请输入项目名称");
    return;
  }
  const editingId = $("#save-project-btn").dataset.editProjectId;
  const existing = editingId ? state.projects.find((item) => item.id === editingId) : null;
  const ts = now();
  const project = {
    id: existing?.id || uid("project"),
    name,
    description,
    createdAt: existing?.createdAt || ts,
    updatedAt: ts,
  };
  const saved = await put("projects", project);
  const idx = state.projects.findIndex((item) => item.id === saved.id);
  if (idx >= 0) state.projects[idx] = saved;
  else state.projects.unshift(saved);
  state.projects.sort((a, b) => b.updatedAt - a.updatedAt);
  $("#project-name-input").value = "";
  $("#project-desc-input").value = "";
  delete $("#save-project-btn").dataset.editProjectId;
  $("#save-project-btn").textContent = "新建项目";
  if (!existing) await switchProject(saved.id);
  else renderProjects();
}

async function switchProject(projectId) {
  if (!projectId || projectId === state.currentProjectId) return;
  state.currentProjectId = projectId;
  localStorage.setItem("picsetCurrentProjectId", projectId);
  state.currentConversationId = null;
  state.pendingImages = [];
  state.activeGalleryFolderId = "all";
  resetStoryboardStateOnly();
  await loadAll();
  renderAll();
  setSidebarOpen(false);
}

function renderConversationList() {
  const list = $("#conversation-list");
  list.innerHTML = "";
  for (const conv of state.conversations) {
    const count = state.messages.filter((msg) => msg.conversationId === conv.id).length;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `conversation-item ${conv.id === state.currentConversationId ? "active" : ""}`;
    btn.innerHTML = `<div class="conversation-title">${escapeHtml(conv.title)}</div><div class="conversation-meta">${count} 条 · ${fmtTime(conv.updatedAt)}</div>`;
    btn.onclick = () => {
      state.currentConversationId = conv.id;
      state.pendingImages = [];
      renderAll();
      setSidebarOpen(false);
    };
    list.appendChild(btn);
  }
}

function renderChat() {
  const wrap = $("#chat-scroll");
  const msgs = currentMessages();
  wrap.innerHTML = "";
  if (!msgs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="empty-copy">
        <h1>从描述到成图，再继续编辑</h1>
        <p>输入画面描述，或加入参考图进行带图编辑。生成时会显示请求、排队、渲染、保活、失败重试等过程状态；出图后可以保存、复用、标注，再提交下一轮编辑。</p>
      </div>
      <div class="example-list">
        ${examples.map((item) => `<button type="button" data-example="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}
      </div>
    `;
    wrap.appendChild(empty);
    $$(".example-list button", empty).forEach((btn) => {
      btn.onclick = () => {
        $("#prompt-input").value = btn.dataset.example;
        autoresizePrompt();
        $("#prompt-input").focus();
      };
    });
    return;
  }
  for (const msg of msgs) wrap.appendChild(renderMessage(msg));
  wrap.scrollTop = wrap.scrollHeight;
}

function renderMessage(msg) {
  const node = document.createElement("article");
  node.className = `message ${msg.role}`;
  node.dataset.id = msg.id;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (msg.role === "user") renderUserBubble(msg, bubble);
  else if (msg.status === "pending") renderPendingBubble(msg, bubble);
  else if (msg.status === "done") renderDoneBubble(msg, bubble);
  else renderErrorBubble(msg, bubble);
  node.appendChild(bubble);
  return node;
}

function renderUserBubble(msg, bubble) {
  bubble.innerHTML = `
    <div class="message-text">${escapeHtml(msg.text || "")}</div>
    ${renderRefsHtml(msg.images || [])}
    <div class="message-meta">
      <span>${escapeHtml(msg.params?.size || "auto")} · ${escapeHtml(msg.params?.quality || "high")} · ${escapeHtml(msg.params?.format || "png")}</span>
      ${msg.seed ? `<span>种子 ${msg.seed}</span>` : ""}
    </div>
  `;
}

function renderRefsHtml(images) {
  if (!images.length) return "";
  return `<div class="ref-images">${images.map((src) => `<img src="${src}" alt="参考图">`).join("")}</div>`;
}

function renderPendingBubble(msg, bubble) {
  const progress = msg.progress || {};
  const width = Math.min(92, Math.max(14, progress.percent || 18));
  const partial = progress.partial ? `<img class="partial-preview level-${progress.partialIndex || 0}" src="${progress.partial}" alt="部分预览">` : "";
  bubble.classList.add("loading-card");
  bubble.innerHTML = `
    <div class="progress-visual">${partial}</div>
    <div class="loading-title">${escapeHtml(progress.label || "准备生成")}</div>
    <div class="progress-line"><div class="progress-fill" style="width:${width}%"></div></div>
    ${msg.retryAttempt ? `<div class="retry-hint">上次请求失败，正在自动重试 ${msg.retryAttempt}/${state.settings.retries}，任务仍在继续</div>` : ""}
    <ul class="log-list">${(msg.logs || []).slice(-8).map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
    <div class="result-actions">
      <button class="action-btn danger" data-cancel="${msg.id}" type="button">取消生成</button>
    </div>
  `;
  $("[data-cancel]", bubble).onclick = () => cancelTask(msg.id);
}

function renderDoneBubble(msg, bubble) {
  bubble.innerHTML = `
    <img class="result-img" src="${msg.image}" alt="生成结果">
    <div class="message-meta">
      <span>${escapeHtml(msg.params?.size || "auto")} · ${escapeHtml(msg.params?.quality || "high")} · ${escapeHtml(msg.params?.format || "png")}</span>
      <span>${msg.bytes ? `${msg.bytes} bytes` : "已生成"}</span>
      ${msg.elapsedMs ? `<span>${Math.round(msg.elapsedMs / 1000)} 秒</span>` : ""}
    </div>
    ${msg.text ? `<div class="message-text" style="margin-top:8px">${escapeHtml(msg.text)}</div>` : ""}
    <div class="result-actions">
      <button class="action-btn" data-download="${msg.id}" type="button">下载</button>
      <button class="action-btn" data-copy="${msg.id}" type="button">复制</button>
      <button class="action-btn" data-reroll="${msg.id}" type="button">再来一张</button>
      <button class="action-btn warn" data-edit="${msg.id}" type="button">带图编辑</button>
      <button class="action-btn warn" data-mark="${msg.id}" type="button">标注</button>
      <button class="action-btn" data-archive="${msg.id}" type="button">归档</button>
      <button class="action-btn" data-fav="${msg.id}" type="button">收藏描述</button>
    </div>
  `;
  $("[data-download]", bubble).onclick = () => downloadImage(msg.image, `image-${msg.id}.${msg.params?.format || "png"}`);
  $("[data-copy]", bubble).onclick = () => copyImage(msg.image);
  $("[data-reroll]", bubble).onclick = () => reroll(msg);
  $("[data-edit]", bubble).onclick = () => openEditModal(msg);
  $("[data-mark]", bubble).onclick = () => openMarkEditor(msg.image, (marked) => openEditModal({ ...msg, image: marked }, "请根据我标注的位置和说明进行二次编辑："));
  $("[data-archive]", bubble).onclick = () => openFolderPickerForMessage(msg.id);
  $("[data-fav]", bubble).onclick = () => addFavorite(msg.sourcePrompt || msg.text || "");
}

function renderErrorBubble(msg, bubble) {
  const isCancelled = msg.status === "cancelled";
  const isTimeout = msg.status === "timeout";
  bubble.innerHTML = `
    <div class="message-text">${escapeHtml(isCancelled ? "已取消生成" : isTimeout ? "生成超时" : "生成失败")}</div>
    <div class="message-meta">${escapeHtml(msg.error || "")}</div>
    <div class="result-actions">
      <button class="action-btn warn" data-retry="${msg.id}" type="button">重试</button>
    </div>
  `;
  $("[data-retry]", bubble).onclick = () => reroll(msg);
}

function renderGallery() {
  const grid = $("#gallery-grid");
  grid.innerHTML = "";
  const items = filteredGalleryItems();
  for (const item of items.slice(0, 120)) {
    const cell = document.createElement("div");
    cell.className = "gallery-thumb";
    cell.innerHTML = `
      <img src="${item.image}" alt="${escapeHtml(item.prompt || "作品图片")}">
      <div class="gallery-overlay">
        <button type="button" data-ref="${item.id}">参考</button>
        <button type="button" data-move="${item.id}">移动</button>
      </div>
    `;
    $("[data-ref]", cell).onclick = () => {
      addPendingImage(item.image);
      toast("已加入参考");
    };
    $("[data-move]", cell).onclick = () => openFolderPickerForGalleryItem(item.id);
    grid.appendChild(cell);
  }
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    empty.textContent = state.activeGalleryFolderId === "all" ? "还没有作品。" : "这个文件夹里还没有作品。";
    grid.appendChild(empty);
  }
}

function filteredGalleryItems() {
  if (state.activeGalleryFolderId === "all") return state.gallery;
  if (state.activeGalleryFolderId === "unfiled") return state.gallery.filter((item) => !item.folderId);
  return state.gallery.filter((item) => item.folderId === state.activeGalleryFolderId);
}

function renderFolderList() {
  const list = $("#folder-list");
  if (!list) return;
  const allCount = state.gallery.length;
  const unfiledCount = state.gallery.filter((item) => !item.folderId).length;
  const rows = [
    { id: "all", name: "全部作品", count: allCount },
    { id: "unfiled", name: "未归档", count: unfiledCount },
    ...state.galleryFolders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      count: state.gallery.filter((item) => item.folderId === folder.id).length,
    })),
  ];
  list.innerHTML = "";
  for (const folder of rows) {
    const row = document.createElement("div");
    row.className = "folder-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `folder-chip ${folder.id === state.activeGalleryFolderId ? "active" : ""}`;
    btn.innerHTML = `<span>${escapeHtml(folder.name)}</span><em>${folder.count}</em>`;
    btn.onclick = () => {
      state.activeGalleryFolderId = folder.id;
      renderFolderList();
      renderGallery();
    };
    row.appendChild(btn);
    if (!["all", "unfiled"].includes(folder.id)) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "folder-delete";
      delBtn.textContent = "×";
      delBtn.title = "删除文件夹";
      delBtn.onclick = () => deleteGalleryFolder(folder.id);
      row.appendChild(delBtn);
    }
    list.appendChild(row);
  }
}

async function createGalleryFolder(name) {
  const clean = String(name || "").trim() || "新文件夹";
  const existing = state.galleryFolders.find((folder) => folder.name === clean);
  if (existing) return existing;
  const folder = { id: uid("folder"), projectId: state.currentProjectId, name: clean, createdAt: now(), updatedAt: now() };
  const saved = await put("galleryFolders", folder);
  state.galleryFolders.push(saved);
  renderFolderList();
  return saved;
}

function galleryFolderName(folderId) {
  if (!folderId) return "未归档";
  return state.galleryFolders.find((folder) => folder.id === folderId)?.name || "已删除文件夹";
}

async function deleteGalleryFolder(folderId) {
  const folder = state.galleryFolders.find((item) => item.id === folderId);
  if (!folder) return;
  if (!confirm(`删除文件夹「${folder.name}」？作品会保留并移到未归档。`)) return;
  state.galleryFolders = state.galleryFolders.filter((item) => item.id !== folderId);
  await del("galleryFolders", folderId);
  for (const item of state.gallery) {
    if (item.folderId === folderId) {
      item.folderId = null;
      await put("gallery", item);
    }
  }
  for (const msg of state.messages) {
    if (msg.folderId === folderId) {
      msg.folderId = null;
      await updateMessage(msg.id, msg);
    }
  }
  if (state.activeGalleryFolderId === folderId) state.activeGalleryFolderId = "unfiled";
  renderFolderList();
  renderGallery();
}

function renderFavorites() {
  $("#favorites-count").textContent = state.favorites.length ? `(${state.favorites.length})` : "";
  const list = $("#favorites-list");
  list.innerHTML = "";
  for (const fav of state.favorites) {
    const item = document.createElement("div");
    item.className = "fav-item";
    item.innerHTML = `<button type="button">${escapeHtml(fav.prompt)}</button>`;
    $("button", item).onclick = () => {
      $("#prompt-input").value = fav.prompt;
      autoresizePrompt();
      $("#prompt-input").focus();
    };
    list.appendChild(item);
  }
}

function renderAssets() {
  const list = $("#asset-list");
  if (!list) return;
  list.innerHTML = "";
  for (const asset of state.assets) {
    const card = document.createElement("div");
    card.className = "asset-card";
    card.innerHTML = `
      <strong>@${escapeHtml(asset.name)}</strong>
      <small>${asset.type === "character" ? "角色" : asset.type === "scene" ? "场景" : "道具"}</small>
      <p>${escapeHtml(asset.desc)}</p>
      <div class="result-actions">
        <button class="action-btn" data-use="${asset.id}" type="button">插入</button>
        <button class="action-btn danger" data-del="${asset.id}" type="button">删除</button>
      </div>
    `;
    $("[data-use]", card).onclick = () => {
      const input = $("#prompt-input");
      input.value = `${input.value}${input.value ? " " : ""}@${asset.name}`;
      autoresizePrompt();
      closeModal("assets-modal");
    };
    $("[data-del]", card).onclick = async () => {
      await del("assets", asset.id);
      state.assets = state.assets.filter((item) => item.id !== asset.id);
      renderAssets();
    };
    list.appendChild(card);
  }
}

function renderPendingImages() {
  const strip = $("#reference-strip");
  strip.innerHTML = "";
  strip.classList.toggle("hidden", state.pendingImages.length === 0);
  state.pendingImages.forEach((src, index) => {
    const chip = document.createElement("div");
    chip.className = "ref-chip";
    chip.innerHTML = `<img src="${src}" alt="参考图"><button type="button" title="移除">×</button>`;
    $("button", chip).onclick = () => {
      state.pendingImages.splice(index, 1);
      renderPendingImages();
    };
    chip.ondblclick = () => openMarkEditor(src, (marked) => {
      state.pendingImages[index] = marked;
      renderPendingImages();
    });
    strip.appendChild(chip);
  });
  updateSendAffordance();
}

function renderModelMenu() {
  enforceStandardModel();
  const models = allowedImageModels();
  $("#current-model").textContent = modelLabel(state.settings.model).name;
  const menu = $("#model-menu");
  menu.innerHTML = "";
  for (const model of models) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `model-choice ${model.id === state.settings.model ? "active" : ""}`;
    const label = modelLabel(model.id, model);
    btn.innerHTML = `<strong>${escapeHtml(label.name)}</strong><span>${escapeHtml(label.desc)}</span>`;
    btn.onclick = () => {
      state.settings.model = STANDARD_IMAGE_MODEL;
      saveSettingsLocal();
      renderModelMenu();
      menu.classList.add("hidden");
    };
    menu.appendChild(btn);
  }
}

function modelLabel(id, fallback = {}) {
  return {
    name: fallback.name || MODEL_LABELS[id]?.name || "自定义通道",
    desc: fallback.desc || MODEL_LABELS[id]?.desc || "来自本地偏好设置",
  };
}

function allowedImageModels() {
  const configured = Array.isArray(state.config?.models) ? state.config.models : [];
  const standard = configured.find((model) => model.id === STANDARD_IMAGE_MODEL);
  return [standard || MODEL_OPTIONS[0]];
}

function enforceStandardModel() {
  state.settings.model = STANDARD_IMAGE_MODEL;
}

function enhanceModelLabel(id, fallback = {}) {
  return {
    name: fallback.name || ENHANCE_MODEL_LABELS[id]?.name || id || "默认 LLM",
    desc: fallback.desc || ENHANCE_MODEL_LABELS[id]?.desc || "用于提示词优化和连续出图规划",
  };
}

function allowedEnhanceModels() {
  const configured = Array.isArray(state.config?.enhanceModels) && state.config.enhanceModels.length ? state.config.enhanceModels : ENHANCE_MODEL_OPTIONS;
  const byId = new Map();
  for (const model of [...ENHANCE_MODEL_OPTIONS, ...configured]) {
    if (!model?.id) continue;
    byId.set(model.id, { ...enhanceModelLabel(model.id, model), id: model.id });
  }
  return Array.from(byId.values());
}

function normalizeEnhanceModelSetting() {
  const models = allowedEnhanceModels();
  const ids = new Set(models.map((model) => model.id));
  if (ids.has(state.settings.enhanceModel)) return;
  state.settings.enhanceModel = ids.has(state.config?.enhanceModel) ? state.config.enhanceModel : (models[0]?.id || DEFAULT_ENHANCE_MODEL);
}

function selectedEnhanceModel() {
  normalizeEnhanceModelSetting();
  return state.settings.enhanceModel || DEFAULT_ENHANCE_MODEL;
}

function saveSettingsLocal() {
  enforceStandardModel();
  normalizeEnhanceModelSetting();
  localStorage.setItem("imageWorkbenchSettings", JSON.stringify(state.settings));
}

function loadSettingsLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem("imageWorkbenchSettings") || localStorage.getItem("vsllmCloneSettings") || "{}");
    Object.assign(state.settings, saved);
    enforceStandardModel();
    normalizeEnhanceModelSetting();
  } catch {}
}

function autoresizePrompt() {
  const input = $("#prompt-input");
  input.style.height = "auto";
  const isNarrow = window.matchMedia("(max-width: 640px)").matches;
  input.style.height = `${Math.min(input.scrollHeight, isNarrow ? 128 : 190)}px`;
  updateSendAffordance();
}

function setAppViewportHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
}

function setSidebarOpen(open) {
  $("#sidebar").classList.toggle("open", open);
  document.body.classList.toggle("sidebar-open", open);
}

function updateSendAffordance() {
  const input = $("#prompt-input");
  const send = $("#send-btn");
  if (!input || !send) return;
  const hasText = Boolean(input.value.trim());
  const hasRefs = state.pendingImages.length > 0;
  send.disabled = !hasText && !hasRefs;
  send.textContent = hasRefs ? (hasText ? "编辑" : "描述编辑") : "生成";
  input.placeholder = hasRefs
    ? "说明你想如何编辑参考图，例如：保持主体，把背景换成清晨海边"
    : "描述画面或编辑目标，例如：一只白色小猫坐在窗边，清晨柔和阳光，浅景深";
}

function applyOptionChip(btn) {
  const target = $(`#${btn.dataset.insertTarget}`);
  const text = btn.dataset.insert || btn.textContent.trim();
  if (!target || !text) return;
  const mode = btn.dataset.insertMode || "append";
  const current = target.value.trim();
  if (mode === "replace" || !current) {
    target.value = text;
  } else {
    const isTextarea = target.tagName === "TEXTAREA";
    const sep = isTextarea ? (target.value.endsWith("\n") ? "" : "\n") : "，";
    target.value = `${target.value}${sep}${text}`;
  }
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.focus();
}

function bindOptionChips() {
  $$("[data-insert-target]").forEach((btn) => {
    btn.onclick = () => applyOptionChip(btn);
  });
}

function addPendingImage(src) {
  state.pendingImages.push(src);
  renderPendingImages();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function expandAssets(prompt) {
  const used = [];
  for (const asset of state.assets) {
    const re = new RegExp(`@${asset.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$|，|。|,|\\.)`);
    if (re.test(prompt)) used.push(asset);
  }
  if (!used.length) return prompt;
  const lines = ["", "【资产卡一致性指令】"];
  for (const asset of used) {
    const label = asset.type === "character" ? "角色" : asset.type === "scene" ? "场景" : "道具";
    lines.push(`${label} @${asset.name}: ${asset.desc}`);
  }
  return prompt + "\n" + lines.join("\n");
}

async function sendMessage() {
  const input = $("#prompt-input");
  const rawPrompt = input.value.trim();
  const images = [...state.pendingImages];
  if (!rawPrompt && !images.length) return;
  const prompt = expandAssets(rawPrompt);
  const params = getParams();
  const seed = getSeed();
  const convId = state.currentConversationId;
  if (!convId) return;

  const userMsg = await addMessage({ role: "user", conversationId: convId, text: rawPrompt, images, params, seed, status: "done" });
  if (state.conversations.find((c) => c.id === convId)?.title === "新创作" && rawPrompt) {
    await updateConversation(convId, { title: rawPrompt.slice(0, 22) });
  }
  const botMsg = await addMessage({
    role: "bot",
    conversationId: convId,
    sourcePrompt: rawPrompt,
    requestPrompt: prompt,
    images,
    params,
    seed,
    status: "pending",
    logs: ["已创建本地生成任务"],
    progress: { label: "等待发送请求", percent: 8 },
  });
  input.value = "";
  autoresizePrompt();
  state.pendingImages = [];
  renderAll();
  updateSendAffordance();
  runGeneration(botMsg.id);
  return userMsg;
}

function appendLog(msg, line) {
  msg.logs = [...(msg.logs || []), `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${line}`].slice(-30);
}

function updateProgress(msgId, patch) {
  const msg = state.messages.find((item) => item.id === msgId);
  if (!msg) return;
  msg.progress = { ...(msg.progress || {}), ...patch };
  const el = $(`[data-id="${msgId}"]`);
  if (el) {
    const bubble = $(".bubble", el);
    bubble.innerHTML = "";
    renderPendingBubble(msg, bubble);
  }
}

function updateMessageInDom(msgId) {
  const msg = state.messages.find((item) => item.id === msgId);
  const old = $(`[data-id="${msgId}"]`);
  if (msg && old) old.replaceWith(renderMessage(msg));
}

async function runGeneration(msgId) {
  const msg = state.messages.find((item) => item.id === msgId);
  if (!msg) return;
  const existing = state.activeTasks.get(msgId);
  if (existing?.promise) return existing.promise;

  const controller = new AbortController();
  const taskState = { controller, taskId: msg.taskId || "", promise: null };
  const promise = runGenerationTaskForMessage(msgId, taskState).finally(() => {
    if (state.activeTasks.get(msgId) === taskState) state.activeTasks.delete(msgId);
  });
  taskState.promise = promise;
  state.activeTasks.set(msgId, taskState);
  return promise;
}

function generationRequestPayload(msg) {
  return {
    prompt: msg.requestPrompt || msg.sourcePrompt || msg.text || "",
    images: msg.images || [],
    size: msg.params?.size || "auto",
    quality: msg.params?.quality || "high",
    format: msg.params?.format || "png",
    reasoning: msg.params?.reasoning || "off",
    seed: msg.seed || 0,
    model: STANDARD_IMAGE_MODEL,
    apiBase: state.settings.apiBase || undefined,
    projectId: msg.projectId || state.currentProjectId,
    messageId: msg.id,
  };
}

async function createGenerationTask(payload, signal) {
  const res = await fetch("api/generation-tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await readApiJson(res, "创建后台生成任务失败");
  return data.task;
}

async function fetchGenerationTask(taskId, signal) {
  const res = await fetch(`api/generation-tasks/${encodeURIComponent(taskId)}`, { signal });
  const data = await readApiJson(res, "读取生成任务失败");
  return data.task;
}

async function requestCancelGenerationTask(taskId) {
  const res = await fetch(`api/generation-tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
  const data = await readApiJson(res, "取消生成任务失败");
  return data.task;
}

function makeClientAbortError(message = "用户取消了生成任务") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function applyTaskToPendingMessage(msg, task) {
  if (!msg || !task) return;
  const output = task.output || {};
  msg.taskId = task.id;
  if (Array.isArray(task.logs) && task.logs.length) msg.logs = task.logs.slice(-30);
  if (output.quota && state.auth.user) {
    state.auth.user.quota = output.quota;
    renderAccount();
  }
  const partial = output.partial ? normalizeImageRef(output.partial, msg.params?.format) : msg.progress?.partial;
  const label = output.label
    || (task.status === "queued" ? "后台任务排队中" : task.status === "running" ? "后台生成中" : "等待生成");
  msg.progress = {
    ...(msg.progress || {}),
    label,
    percent: Math.max(8, Math.min(100, Number(task.progress || msg.progress?.percent || 12))),
    partial,
    partialIndex: output.partialIndex ?? msg.progress?.partialIndex ?? 0,
  };
}

function taskToGenerationResult(task) {
  const output = task?.output || {};
  return {
    image: output.image || output.imageUrl || "",
    bytes: Number(output.bytes || 0),
    usage: output.usage || null,
    elapsedMs: output.elapsedMs || 0,
    format: output.format || "png",
    quota: output.quota || null,
  };
}

async function pollGenerationTask(taskId, msgId, signal) {
  let delay = 1200;
  let pollFailures = 0;
  while (true) {
    let task = null;
    try {
      task = await fetchGenerationTask(taskId, signal);
      pollFailures = 0;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      pollFailures += 1;
      const msg = state.messages.find((item) => item.id === msgId);
      if (msg) {
        if (pollFailures === 1 || pollFailures % 5 === 0) appendLog(msg, "进度连接中断，正在重连后台任务");
        updateProgress(msgId, {
          label: "正在重连后台任务",
          percent: Math.max(msg.progress?.percent || 18, 18),
        });
        await updateMessage(msgId, msg);
        updateMessageInDom(msgId);
      }
      await sleep(Math.min(5000, delay + pollFailures * 500));
      continue;
    }
    const msg = state.messages.find((item) => item.id === msgId);
    if (!msg) return task;
    applyTaskToPendingMessage(msg, task);
    await updateMessage(msgId, msg);
    updateMessageInDom(msgId);

    if (task.status === "succeeded") return task;
    if (task.status === "failed") throw new Error(task.error || task.output?.error || "生成失败");
    if (task.status === "cancelled") throw makeClientAbortError(task.error || "用户取消了生成任务");

    await sleep(delay);
    delay = Math.min(3000, delay + 300);
  }
}

async function runGenerationTaskForMessage(msgId, taskState) {
  const msg = state.messages.find((item) => item.id === msgId);
  if (!msg) return;
  const maxAttempts = 1 + Number(state.settings.retries || 0);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const taskId = taskState.taskId || msg.taskId || "";
    msg.status = "pending";
    msg.retryAttempt = attempt;
    appendLog(msg, taskId ? "恢复后台生成任务" : attempt === 0 ? "创建后台生成任务" : `自动重试第 ${attempt} 次`);
    updateProgress(msgId, {
      label: taskId ? "恢复后台任务轮询" : attempt === 0 ? "后台任务创建中" : `自动重试中 ${attempt}/${maxAttempts - 1}`,
      percent: taskId ? Math.max(msg.progress?.percent || 18, 18) : 10,
    });
    await updateMessage(msgId, msg);

    try {
      let activeTaskId = taskId;
      if (!activeTaskId) {
        const created = await createGenerationTask(generationRequestPayload(msg), taskState.controller.signal);
        activeTaskId = created.id;
        taskState.taskId = activeTaskId;
        applyTaskToPendingMessage(msg, created);
        appendLog(msg, `后台任务 ${activeTaskId.slice(-8)} 已创建`);
        await updateMessage(msgId, msg);
        updateMessageInDom(msgId);
      }

      const task = await pollGenerationTask(activeTaskId, msgId, taskState.controller.signal);
      const result = taskToGenerationResult(task);
      const image = normalizeImageRef(result.image, result.format || msg.params?.format);
      if (!image) throw new Error("后台任务完成，但没有返回图片地址");
      msg.status = "done";
      msg.image = image;
      msg.elapsedMs = result.elapsedMs;
      msg.usage = result.usage || null;
      msg.taskId = activeTaskId;
      if (result.quota && state.auth.user) {
        state.auth.user.quota = result.quota;
        renderAccount();
      }
      msg.bytes = result.bytes || estimateDataUrlBytes(image);
      msg.retryAttempt = 0;
      msg.error = "";
      appendLog(msg, "生成完成");
      await updateMessage(msgId, msg);
      const galleryItem = await addGallery(image, msg.sourcePrompt || msg.text || "生成图片", msg.params, msg.folderId || activeOutputFolderId());
      msg.galleryItemId = galleryItem.id;
      await updateMessage(msgId, msg);
      updateMessageInDom(msgId);
      renderFolderList();
      renderGallery();
      return;
    } catch (error) {
      const cancelled = error?.name === "AbortError" || taskState.controller.signal.aborted;
      if (cancelled) {
        msg.status = "cancelled";
        msg.error = "用户取消了生成任务";
        await updateMessage(msgId, msg);
        updateMessageInDom(msgId);
        return;
      }
      const message = error?.message || String(error);
      appendLog(msg, message);
      if (attempt + 1 < maxAttempts && isTransient(message, false)) {
        msg.retryAttempt = attempt + 1;
        msg.taskId = "";
        taskState.taskId = "";
        updateProgress(msgId, { label: `失败后准备自动重试 ${attempt + 1}/${maxAttempts - 1}`, percent: 10 });
        await updateMessage(msgId, msg);
        updateMessageInDom(msgId);
        await sleep(900);
        continue;
      }
      msg.status = "error";
      msg.error = `${message}${attempt > 0 ? `（已自动重试 ${attempt} 次）` : ""}`;
      await updateMessage(msgId, msg);
      updateMessageInDom(msgId);
      return;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransient(message, timedOut) {
  if (timedOut) return true;
  return /5\d\d|timeout|timed out|network|fetch|stream|中断|ECONN|ENOTFOUND|keepalive|上游/i.test(message || "");
}

function cancelTask(msgId) {
  const active = state.activeTasks.get(msgId);
  const msg = state.messages.find((item) => item.id === msgId);
  const taskId = active?.taskId || msg?.taskId || "";
  if (taskId) {
    requestCancelGenerationTask(taskId).catch((error) => {
      console.warn(error);
    });
  }
  if (active?.controller) {
    active.controller.abort();
    return;
  }
  if (msg?.status === "pending") {
    msg.status = "cancelled";
    msg.error = "用户取消了生成任务";
    updateMessage(msgId, msg).then(() => updateMessageInDom(msgId));
  }
}

async function postSse(url, payload, signal, onEvent) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const ctype = res.headers.get("content-type") || "";
  if (!res.ok || !ctype.includes("text/event-stream")) {
    let text = await res.text();
    try { text = JSON.parse(text).error || text; } catch {}
    if (res.status === 401) handleAuthExpired(text || "登录状态已失效，请重新登录");
    throw new Error(text || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";
    for (const raw of parts) {
      const parsed = parseClientSse(raw);
      if (!parsed) continue;
      if (parsed.event === "error") throw new Error(parsed.data.message || "生成失败");
      if (parsed.event === "result") finalResult = parsed.data;
      else onEvent?.(parsed.event, parsed.data);
    }
  }
  if (!finalResult) throw new Error("连接结束，但没有收到结果图");
  return finalResult;
}

function parseClientSse(raw) {
  let event = "message";
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^\s/, ""));
  }
  if (!lines.length) return null;
  return { event, data: JSON.parse(lines.join("\n")) };
}

function estimateDataUrlBytes(dataUrl) {
  if (!String(dataUrl || "").startsWith("data:")) return 0;
  const body = String(dataUrl).split(",")[1] || "";
  return Math.floor(body.length * 0.75);
}

async function addGallery(image, prompt, params, folderId = null) {
  const item = { id: uid("gal"), projectId: state.currentProjectId, image, prompt, params, folderId: folderId || null, createdAt: now(), updatedAt: now() };
  const saved = await put("gallery", item);
  state.gallery.unshift(saved);
  return saved;
}

function activeOutputFolderId() {
  return state.activeGalleryFolderId && !["all", "unfiled"].includes(state.activeGalleryFolderId)
    ? state.activeGalleryFolderId
    : null;
}

async function ensureGalleryItemForMessage(msgId) {
  const msg = state.messages.find((item) => item.id === msgId);
  if (!msg || !msg.image) return null;
  if (msg.galleryItemId) {
    const found = state.gallery.find((item) => item.id === msg.galleryItemId);
    if (found) return found;
  }
  let item = state.gallery.find((galleryItem) => galleryItem.image === msg.image);
  if (!item) item = await addGallery(msg.image, msg.sourcePrompt || msg.text || "生成图片", msg.params);
  msg.galleryItemId = item.id;
  await updateMessage(msg.id, msg);
  return item;
}

async function openFolderPickerForMessage(msgId) {
  const item = await ensureGalleryItemForMessage(msgId);
  if (!item) {
    toast("没有可归档的作品");
    return;
  }
  openFolderPickerForGalleryItem(item.id);
}

function openFolderPickerForGalleryItem(galleryItemId) {
  state.folderPickContext = { galleryItemId };
  renderFolderPicker();
  openModal("folder-picker-modal");
}

function renderFolderPicker() {
  const list = $("#folder-picker-list");
  if (!list) return;
  const item = state.gallery.find((galleryItem) => galleryItem.id === state.folderPickContext?.galleryItemId);
  list.innerHTML = "";
  const choices = [
    { id: null, name: "未归档" },
    ...state.galleryFolders.map((folder) => ({ id: folder.id, name: folder.name })),
  ];
  for (const choice of choices) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `folder-pick-row ${item?.folderId === choice.id ? "active" : ""}`;
    btn.innerHTML = `<span>${escapeHtml(choice.name)}</span>${item?.folderId === choice.id ? "<em>当前</em>" : ""}`;
    btn.onclick = async () => {
      if (!item) return;
      item.folderId = choice.id;
      await put("gallery", item);
      const msg = state.messages.find((message) => message.galleryItemId === item.id);
      if (msg) {
        msg.folderId = choice.id;
        await updateMessage(msg.id, msg);
      }
      closeModal("folder-picker-modal");
      renderFolderList();
      renderGallery();
      toast(`已归档到 ${choice.name}`);
    };
    list.appendChild(btn);
  }
}

async function addFavorite(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return;
  const exists = state.favorites.some((item) => item.prompt === text);
  if (exists) {
    toast("提示词已收藏");
    return;
  }
  const fav = { id: uid("fav"), projectId: state.currentProjectId, prompt: text, createdAt: now(), updatedAt: now() };
  const saved = await put("favorites", fav);
  state.favorites.unshift(saved);
  renderFavorites();
  toast("已收藏提示词");
}

function downloadImage(dataUrl, filename) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copyImage(dataUrl) {
  try {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error("浏览器不支持图片剪贴板");
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    toast("已复制图片");
  } catch (error) {
    toast(error.message || "复制失败");
  }
}

async function reroll(source) {
  const params = source.params || getParams();
  const botMsg = await addMessage({
    role: "bot",
    conversationId: source.conversationId || state.currentConversationId,
    sourcePrompt: source.sourcePrompt || source.text || "",
    requestPrompt: source.requestPrompt || expandAssets(source.sourcePrompt || source.text || ""),
    images: source.images || [],
    params,
    seed: source.seed || 0,
    status: "pending",
    logs: ["已从历史消息重新提交"],
    progress: { label: "准备重新生成", percent: 8 },
  });
  renderChat();
  runGeneration(botMsg.id);
}

function openEditModal(msg, preset = "") {
  state.editContext = { ...msg };
  $("#edit-preview").src = msg.image;
  $("#edit-prompt").value = preset || "";
  openModal("edit-modal");
}

async function confirmEditGenerate() {
  if (!state.editContext) return;
  const instruction = $("#edit-prompt").value.trim();
  if (!instruction) {
    toast("请填写编辑说明");
    return;
  }
  closeModal("edit-modal");
  const params = getParams();
  const botMsg = await addMessage({
    role: "bot",
    conversationId: state.editContext.conversationId || state.currentConversationId,
    sourcePrompt: instruction,
    requestPrompt: expandAssets(instruction),
    images: [state.editContext.image],
    params,
    seed: getSeed(),
    status: "pending",
    logs: ["已提交二次编辑任务"],
    progress: { label: "准备图生图编辑", percent: 8 },
  });
  renderChat();
  runGeneration(botMsg.id);
}

async function enhancePrompt() {
  const input = $("#prompt-input");
  const prompt = input.value.trim();
  if (!prompt) {
    toast("先输入提示词");
    return;
  }
  $("#enhance-btn").disabled = true;
  $("#enhance-btn").textContent = "优化中";
  try {
    const res = await fetch("api/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, apiBase: state.settings.apiBase || undefined, enhanceModel: selectedEnhanceModel() }),
    });
    const data = await readApiJson(res, "提示词增强失败");
    input.value = data.prompt;
    autoresizePrompt();
    toast("提示词已优化");
  } catch (error) {
    toast(error.message || "提示词增强失败");
  } finally {
    $("#enhance-btn").disabled = false;
    $("#enhance-btn").textContent = "优化提示词";
  }
}

function openGalleryPicker() {
  const grid = $("#gallery-picker-grid");
  grid.innerHTML = "";
  state.galleryPick.clear();
  for (const item of state.gallery) {
    const cell = document.createElement("div");
    cell.className = "picker-thumb";
    cell.innerHTML = `<img src="${item.image}" alt="${escapeHtml(item.prompt || "图库图片")}"><button type="button"></button>`;
    $("button", cell).onclick = () => {
      if (state.galleryPick.has(item.id)) {
        state.galleryPick.delete(item.id);
        cell.classList.remove("selected");
      } else {
        state.galleryPick.add(item.id);
        cell.classList.add("selected");
      }
    };
    grid.appendChild(cell);
  }
  openModal("gallery-picker-modal");
}

function usePickedGallery() {
  for (const id of state.galleryPick) {
    const item = state.gallery.find((g) => g.id === id);
    if (item) addPendingImage(item.image);
  }
  closeModal("gallery-picker-modal");
}

function roleLabel(role) {
  return {
    owner: "所有者",
    admin: "管理员",
    member: "成员",
    viewer: "访客",
  }[role] || role || "--";
}

function statusLabel(status) {
  return {
    active: "正常",
    disabled: "停用",
    setup_required: "待配置",
  }[status] || status || "--";
}

function fullTime(ts) {
  if (!ts) return "--";
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function loadAdminUsers(selectUserId = state.admin.selectedUserId) {
  state.admin.busy = true;
  renderAdminSummary();
  try {
    const res = await fetch("api/admin/users");
    const data = await readApiJson(res, "读取用户管理数据失败");
    state.admin.users = data.users || [];
    state.admin.overview = data.overview || null;
    state.admin.selectedUserId = selectUserId || state.admin.users[0]?.id || "";
    renderAdminSummary();
    renderAdminUserList();
    if (state.admin.selectedUserId) await loadAdminUserDetail(state.admin.selectedUserId);
  } catch (error) {
    toast(error.message || "读取用户管理数据失败");
  } finally {
    state.admin.busy = false;
    renderAdminSummary();
  }
}

function renderAdminSummary() {
  const wrap = $("#admin-summary");
  if (!wrap) return;
  const overview = state.admin.overview;
  if (state.admin.busy && !overview) {
    wrap.innerHTML = `<div class="admin-stat"><strong>加载中</strong><span>正在读取用户和数据总览</span></div>`;
    return;
  }
  const stats = [
    { label: "用户总数", value: overview?.users?.total ?? "--", sub: `${overview?.users?.active ?? "--"} 个正常账号` },
    { label: "管理员", value: overview?.users?.admin ?? "--", sub: "owner / admin" },
    { label: "成功生成", value: overview?.usage?.succeeded ?? "--", sub: `${overview?.usage?.refunded ?? "--"} 次失败返还` },
    { label: "作品数据", value: overview?.records?.gallery ?? "--", sub: `${overview?.records?.messages ?? "--"} 条消息记录` },
  ];
  wrap.innerHTML = stats.map((stat) => `
    <div class="admin-stat">
      <span>${escapeHtml(stat.label)}</span>
      <strong>${escapeHtml(stat.value)}</strong>
      <em>${escapeHtml(stat.sub)}</em>
    </div>
  `).join("");
}

function renderAdminUserList() {
  const list = $("#admin-user-list");
  if (!list) return;
  $("#admin-user-count").textContent = `${state.admin.users.length} 个`;
  list.innerHTML = "";
  for (const user of state.admin.users) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `admin-user-row ${user.id === state.admin.selectedUserId ? "active" : ""}`;
    btn.innerHTML = `
      <div>
        <strong>${escapeHtml(user.displayName || user.username || user.email)}</strong>
        <span>${escapeHtml(user.email)} · ${escapeHtml(roleLabel(user.role))}</span>
      </div>
      <em>${escapeHtml(quotaDisplay(user.quota))}</em>
    `;
    btn.onclick = () => loadAdminUserDetail(user.id);
    list.appendChild(btn);
  }
}

async function loadAdminUserDetail(userId) {
  if (!userId) return;
  state.admin.selectedUserId = userId;
  renderAdminUserList();
  $("#admin-detail-empty")?.classList.add("hidden");
  $("#admin-detail-content")?.classList.remove("hidden");
  $("#admin-detail-name").textContent = "加载中";
  $("#admin-detail-email").textContent = "";
  try {
    const res = await fetch(`api/admin/users/${encodeURIComponent(userId)}/overview`);
    const data = await readApiJson(res, "读取用户详情失败");
    state.admin.selectedUser = data.user || null;
    renderAdminDetail();
  } catch (error) {
    toast(error.message || "读取用户详情失败");
  }
}

function renderAdminDetail() {
  const user = state.admin.selectedUser;
  if (!user) {
    $("#admin-detail-empty")?.classList.remove("hidden");
    $("#admin-detail-content")?.classList.add("hidden");
    return;
  }
  $("#admin-detail-empty")?.classList.add("hidden");
  $("#admin-detail-content")?.classList.remove("hidden");
  $("#admin-detail-name").textContent = user.displayName || user.username || user.email;
  $("#admin-detail-email").textContent = `${user.email} · ${statusLabel(user.status)} · 注册 ${fullTime(user.createdAt)}`;
  $("#admin-detail-role").textContent = roleLabel(user.role);
  $("#admin-quota-total").value = Number(user.quota?.total ?? 10);
  $("#admin-quota-used").value = Number(user.quota?.used ?? 0);

  const recordMap = {
    projects: "项目",
    conversations: "会话",
    messages: "消息",
    gallery: "作品",
    galleryFolders: "文件夹",
    favorites: "提示词",
    assets: "素材",
  };
  const recordRows = Object.entries(recordMap).map(([key, label]) => ({
    label,
    value: Number(user.records?.[key] || 0),
  }));
  recordRows.unshift(
    { label: "成功生成", value: Number(user.usage?.succeeded || 0) },
    { label: "额度状态", value: quotaDisplay(user.quota) },
  );
  $("#admin-record-grid").innerHTML = recordRows.map((item) => `
    <div class="admin-record-card">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
    </div>
  `).join("");

  const events = Array.isArray(user.recentUsage) ? user.recentUsage : [];
  $("#admin-usage-list").innerHTML = events.length ? events.map((event) => `
    <div class="admin-usage-row">
      <div>
        <strong>${escapeHtml(event.status === "succeeded" ? "生成成功" : event.status === "refunded" ? "已返还" : event.status)}</strong>
        <span>${escapeHtml(event.input?.prompt || "无提示词记录")}</span>
      </div>
      <em>${escapeHtml(fullTime(event.createdAt))}</em>
    </div>
  `).join("") : `<div class="admin-empty inline">还没有生成事件。</div>`;
}

async function saveAdminQuota(resetUsed = false) {
  const user = state.admin.selectedUser;
  if (!user) return;
  const quotaTotal = Number($("#admin-quota-total").value);
  const quotaUsed = resetUsed ? 0 : Number($("#admin-quota-used").value);
  $("#admin-save-quota-btn").disabled = true;
  try {
    const res = await fetch(`api/admin/users/${encodeURIComponent(user.id)}/quota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quotaTotal, quotaUsed }),
    });
    const data = await readApiJson(res, "保存次数失败");
    state.admin.selectedUser = data.user;
    const idx = state.admin.users.findIndex((item) => item.id === data.user.id);
    if (idx >= 0) state.admin.users[idx] = { ...state.admin.users[idx], ...data.user };
    if (state.auth.user?.id === data.user.id) {
      state.auth.user.quota = data.user.quota;
      renderAccount();
    }
    renderAdminUserList();
    renderAdminDetail();
    toast("次数配置已保存");
  } catch (error) {
    toast(error.message || "保存次数失败");
  } finally {
    $("#admin-save-quota-btn").disabled = false;
  }
}

async function openAdminModal() {
  if (!isGlobalAdminUser()) {
    toast("需要管理员权限");
    return;
  }
  openModal("admin-modal");
  await loadAdminUsers();
}

function resetStoryboardStateOnly() {
  state.storyboard = { title: "", anchors: [], frames: [], run: null, busy: "" };
}

function resetStoryboard() {
  resetStoryboardStateOnly();
  $("#storyboard-story").value = "";
  $("#storyboard-count").value = "6";
  $("#storyboard-style").value = "电影感，写实摄影，统一色调";
  $("#storyboard-folder-name").value = "";
  $("#storyboard-continuity").value = "";
  $("#storyboard-status").textContent = "先规划角色、关键对象和核心主题。";
  $("#storyboard-anchor-list").innerHTML = "";
  $("#storyboard-frame-list").innerHTML = "";
  updateStoryboardControls("plan");
}

async function planStoryboard() {
  const story = $("#storyboard-story").value.trim();
  const count = Math.max(1, Math.min(24, Number($("#storyboard-count").value || 6)));
  const style = $("#storyboard-style").value.trim();
  const continuity = $("#storyboard-continuity").value.trim();
  const anchors = storyboardAnchorPayload(currentStoryboardAnchors());
  if (!story) {
    toast("先输入剧情");
    return;
  }
  const previousAnchors = state.storyboard.anchors || [];
  $("#storyboard-plan-btn").disabled = true;
  state.storyboard.busy = "plan";
  updateStoryboardControls("plan");
  $("#storyboard-plan-btn").textContent = "规划中";
  $("#storyboard-status").textContent = "正在规划角色、关键对象、核心主题和分镜...";
  try {
    const res = await fetch("api/storyboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ story, count, style, continuity, anchors, apiBase: state.settings.apiBase || undefined, enhanceModel: selectedEnhanceModel() }),
    });
    const data = await readApiJson(res, "剧情拆分失败");
    state.storyboard = {
      title: data.title || "连续出图",
      anchors: mergeStoryboardAnchors(Array.isArray(data.anchors) ? data.anchors : [], previousAnchors),
      frames: data.frames || [],
      run: state.storyboard.run || null,
      busy: "",
    };
    if (!$("#storyboard-folder-name").value.trim()) $("#storyboard-folder-name").value = state.storyboard.title;
    renderStoryboardAnchors();
    renderStoryboardFrames();
    $("#storyboard-status").textContent = `已规划 ${state.storyboard.anchors.length} 个核心参考项和 ${state.storyboard.frames.length} 张分镜。先生成核心参考图。`;
    updateStoryboardControls("refs");
  } catch (error) {
    $("#storyboard-status").textContent = error.message || "剧情拆分失败";
    toast(error.message || "剧情拆分失败");
    state.storyboard.busy = "";
    updateStoryboardControls("plan");
  } finally {
    $("#storyboard-plan-btn").disabled = false;
    $("#storyboard-plan-btn").textContent = "规划核心与剧情";
    state.storyboard.busy = "";
    updateStoryboardControls();
  }
}

function anchorTypeLabel(type) {
  return ANCHOR_TYPES.find((item) => item.id === type)?.name || "主题";
}

function anchorDescPlaceholder(type) {
  return {
    character: "外貌、年龄感、发型、服装、配饰、气质。",
    object: "形状比例、材质、颜色、纹理、标志性细节。",
    location: "空间结构、关键陈设、光线方向、主色调。",
    theme: "核心符号、色调、材质、光影和氛围。",
  }[type] || "固定设定";
}

function anchorLockPlaceholder(type) {
  return {
    character: "每张图保持同一张脸、发型、服装和标志配饰。",
    object: "每张图保持同一形状、材质、颜色和关键细节。",
    location: "相关画面保持同一空间结构、光线和视觉氛围。",
    theme: "所有画面保持同一主题符号、色调和情绪。",
  }[type] || "视觉锁定";
}

function normalizeStoryboardAnchor(anchor, index = 0) {
  return {
    sourceIndex: anchor?.sourceIndex ?? index,
    type: ANCHOR_TYPES.some((item) => item.id === anchor?.type) ? anchor.type : "theme",
    name: String(anchor?.name || `核心设定 ${index + 1}`).trim(),
    description: String(anchor?.description || "").trim(),
    visualLock: String(anchor?.visualLock || "").trim(),
    image: String(anchor?.image || "").trim(),
    status: String(anchor?.status || "").trim(),
    error: String(anchor?.error || "").trim(),
    messageId: anchor?.messageId || "",
  };
}

function currentStoryboardAnchors() {
  return (state.storyboard.anchors || [])
    .map(normalizeStoryboardAnchor)
    .filter((anchor) => anchor.name && (anchor.description || anchor.visualLock));
}

function storyboardAnchorPayload(anchors = currentStoryboardAnchors()) {
  return anchors.map((anchor) => ({
    type: anchor.type,
    name: anchor.name,
    description: anchor.description,
    visualLock: anchor.visualLock,
  }));
}

function storyboardFrameItems() {
  return (state.storyboard.frames || []).map((frame, index) => ({
    ...frame,
    index: index + 1,
    prompt: String(frame.prompt || "").trim(),
  })).filter((frame) => frame.prompt);
}

function mergeStoryboardAnchors(nextAnchors, previousAnchors = []) {
  const previous = previousAnchors.map(normalizeStoryboardAnchor);
  return nextAnchors.map((anchor, index) => {
    const item = normalizeStoryboardAnchor(anchor, index);
    const matched = previous.find((old) => old.type === item.type && old.name === item.name)
      || previous.find((old) => old.name === item.name);
    if (!matched?.image) return item;
    return {
      ...item,
      image: matched.image,
      status: matched.status || "done",
      error: "",
      messageId: matched.messageId || "",
    };
  });
}

function storyboardReferenceImages(anchors = currentStoryboardAnchors()) {
  return anchors.map((anchor) => anchor.image).filter(Boolean);
}

function frameReferenceImages(frame, anchors = currentStoryboardAnchors(), maxRefs = 3) {
  const text = `${frame.title || ""}\n${frame.beat || ""}\n${frame.prompt || ""}`.toLowerCase();
  const scored = anchors
    .filter((anchor) => anchor.image)
    .map((anchor, index) => {
      const name = String(anchor.name || "").toLowerCase();
      const type = String(anchor.type || "").toLowerCase();
      let score = 0;
      if (name && text.includes(name)) score += 4;
      if (type && text.includes(type)) score += 1;
      if (anchor.type === "character") score += 2;
      if (anchor.type === "object") score += 1.5;
      if (anchor.type === "location" && /room|scene|stage|living|apartment|interior|客厅|场景|地点/.test(text)) score += 1;
      return { anchor, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, maxRefs).map((item) => item.anchor.image);
}

function storyboardHasAllReferences(anchors = currentStoryboardAnchors()) {
  return anchors.length > 0 && anchors.every((anchor) => Boolean(anchor.image));
}

function invalidateAnchorReference(index) {
  const anchor = state.storyboard.anchors?.[index];
  if (!anchor) return;
  anchor.image = "";
  anchor.status = "";
  anchor.error = "";
  anchor.messageId = "";
}

function renderAnchorPreviewState(row, index) {
  const preview = $(".anchor-preview", row);
  const anchor = normalizeStoryboardAnchor(state.storyboard.anchors?.[index], index);
  if (!preview) return;
  const statusText = anchor.image ? "已生成参考图" : anchor.status === "pending" ? "生成中" : anchor.error ? "生成失败" : "等待生成";
  preview.classList.toggle("has-image", Boolean(anchor.image));
  preview.innerHTML = `${anchor.image ? `<img src="${anchor.image}" alt="${escapeHtml(anchor.name)}参考图">` : `<span>${escapeHtml(anchorTypeLabel(anchor.type))}</span>`}<em>${escapeHtml(statusText)}</em>`;
}

function updateStoryboardSteps(stage = "") {
  const anchors = currentStoryboardAnchors();
  const frames = storyboardFrameItems();
  const inferred = stage || (!anchors.length ? "plan" : storyboardHasAllReferences(anchors) && frames.length ? "frames" : "refs");
  $$("[data-storyboard-step]").forEach((item) => {
    const id = item.dataset.storyboardStep;
    item.classList.toggle("active", id === inferred);
    item.classList.toggle("done", (id === "plan" && anchors.length > 0) || (id === "refs" && storyboardHasAllReferences(anchors)));
  });
}

function updateStoryboardControls(stage = "") {
  const anchors = currentStoryboardAnchors();
  const frames = storyboardFrameItems();
  const busy = Boolean(state.storyboard.busy);
  const hasAnchors = anchors.length > 0;
  const hasRefs = storyboardHasAllReferences(anchors);
  const refBtn = $("#storyboard-reference-btn");
  const startBtn = $("#storyboard-start-btn");
  if (refBtn) {
    refBtn.disabled = busy || !hasAnchors;
    refBtn.textContent = state.storyboard.busy === "refs" ? "参考图生成中" : STORYBOARD_REFERENCE_TEXT;
  }
  if (startBtn) {
    startBtn.disabled = busy || !frames.length || !hasRefs;
    startBtn.textContent = state.storyboard.busy === "frames" ? "剧情图生成中" : STORYBOARD_START_TEXT;
  }
  updateStoryboardSteps(stage);
}

function storyboardAnchorBlock(anchors = currentStoryboardAnchors()) {
  return anchors.map((anchor, index) => {
    const parts = [
      `${index + 1}. [${anchorTypeLabel(anchor.type)}] ${anchor.name}`,
      anchor.description ? `固定设定：${anchor.description}` : "",
      anchor.visualLock ? `视觉锁定：${anchor.visualLock}` : "",
    ].filter(Boolean);
    return parts.join("；");
  }).join("\n");
}

function renderStoryboardAnchors() {
  const list = $("#storyboard-anchor-list");
  if (!list) return;
  list.innerHTML = "";
  const anchors = state.storyboard.anchors || [];
  if (!anchors.length) {
    const empty = document.createElement("div");
    empty.className = "anchor-empty";
    empty.textContent = "添加角色、关键对象、地点或核心主题。";
    list.appendChild(empty);
    return;
  }
  anchors.forEach((anchor, index) => {
    const item = normalizeStoryboardAnchor(anchor, index);
    const statusText = item.image ? "已生成参考图" : item.status === "pending" ? "生成中" : item.error ? "生成失败" : "等待生成";
    const row = document.createElement("div");
    row.className = "anchor-card";
    row.innerHTML = `
      <div class="anchor-preview ${item.image ? "has-image" : ""}">
        ${item.image ? `<img src="${item.image}" alt="${escapeHtml(item.name)}参考图">` : `<span>${escapeHtml(anchorTypeLabel(item.type))}</span>`}
        <em>${escapeHtml(statusText)}</em>
      </div>
      <div class="anchor-head">
        <select data-anchor-type="${index}">
          ${ANCHOR_TYPES.map((type) => `<option value="${type.id}">${type.name}</option>`).join("")}
        </select>
        <input data-anchor-name="${index}" type="text" value="${escapeHtml(item.name)}" placeholder="名称">
        <button class="folder-delete" data-anchor-remove="${index}" type="button" title="删除">×</button>
      </div>
      <textarea data-anchor-desc="${index}" rows="2" placeholder="${escapeHtml(anchorDescPlaceholder(item.type))}">${escapeHtml(item.description)}</textarea>
      <textarea data-anchor-lock="${index}" rows="2" placeholder="${escapeHtml(anchorLockPlaceholder(item.type))}">${escapeHtml(item.visualLock)}</textarea>
      ${item.error ? `<div class="anchor-error">${escapeHtml(item.error)}</div>` : ""}
    `;
    const typeSelect = $("[data-anchor-type]", row);
    typeSelect.value = item.type;
    typeSelect.onchange = (event) => {
      state.storyboard.anchors[index].type = event.target.value;
      invalidateAnchorReference(index);
      renderStoryboardAnchors();
      updateStoryboardControls("refs");
    };
    $("[data-anchor-name]", row).oninput = (event) => {
      state.storyboard.anchors[index].name = event.target.value;
      invalidateAnchorReference(index);
      renderAnchorPreviewState(row, index);
      updateStoryboardControls("refs");
    };
    $("[data-anchor-desc]", row).oninput = (event) => {
      state.storyboard.anchors[index].description = event.target.value;
      invalidateAnchorReference(index);
      renderAnchorPreviewState(row, index);
      updateStoryboardControls("refs");
    };
    $("[data-anchor-lock]", row).oninput = (event) => {
      state.storyboard.anchors[index].visualLock = event.target.value;
      invalidateAnchorReference(index);
      renderAnchorPreviewState(row, index);
      updateStoryboardControls("refs");
    };
    $("[data-anchor-remove]", row).onclick = () => {
      state.storyboard.anchors.splice(index, 1);
      renderStoryboardAnchors();
      updateStoryboardControls();
    };
    list.appendChild(row);
  });
}

function addStoryboardAnchor(type = "character") {
  const validType = ANCHOR_TYPES.some((item) => item.id === type) ? type : "character";
  state.storyboard.anchors.push({
    type: validType,
    name: `核心设定 ${state.storyboard.anchors.length + 1}`,
    description: "",
    visualLock: "",
    image: "",
    status: "",
    error: "",
  });
  renderStoryboardAnchors();
  updateStoryboardControls("refs");
}

function anchorReferencePrompt(anchor, style) {
  const type = anchorTypeLabel(anchor.type);
  const typeGuide = {
    character: "生成单个角色参考图：干净背景，正面或三分之二视角，完整外观、发型、服装、配饰清晰，避免加入其他人物。",
    object: "生成单个核心对象参考图：干净背景，形状比例、材质、颜色、纹理和标志性细节清晰，避免加入无关主体。",
    location: "生成核心地点参考图：空间结构、关键陈设、光线方向、主色调和氛围清晰，保持可复用的场景设定。",
    theme: "生成主题视觉参考图：核心符号、色调、材质、光影和氛围统一，作为后续画面的视觉基准。",
  }[anchor.type] || "生成清晰参考图，主体和视觉特征稳定。";
  return [
    `【核心参考图】${type}：${anchor.name}`,
    anchor.description ? `固定设定：${anchor.description}` : "",
    anchor.visualLock ? `视觉锁定：${anchor.visualLock}` : "",
    style ? `视觉风格：${style}` : "",
    typeGuide,
    "这张图会作为后续剧情分镜的参考图使用，因此主体必须清晰、稳定、可复用。不要生成文字、水印或多余说明。",
  ].filter(Boolean).join("\n");
}

async function generateStoryboardAnchorImages(conv, folder, anchors) {
  const style = $("#storyboard-style").value.trim();
  const generated = [];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const index = anchor.sourceIndex;
    if (anchor.image) {
      generated.push(anchor.image);
      continue;
    }
    state.storyboard.anchors[index].status = "pending";
    state.storyboard.anchors[index].error = "";
    renderStoryboardAnchors();
    $("#storyboard-status").textContent = `正在生成核心参考图 ${i + 1}/${anchors.length}：${anchor.name}`;
    const prompt = anchorReferencePrompt(anchor, style);
    const botMsg = await addMessage({
      role: "bot",
      conversationId: conv.id,
      sourcePrompt: `核心参考图：${anchor.name}`,
      requestPrompt: expandAssets(prompt),
      images: [],
      params: getParams(),
      seed: getSeed(),
      folderId: folder.id,
      status: "pending",
      logs: [`核心参考图 ${i + 1}/${anchors.length} 已排队`],
      progress: { label: `准备生成核心参考图 ${i + 1}/${anchors.length}`, percent: 8 },
    });
    renderChat();
    await runGeneration(botMsg.id);
    const updated = state.messages.find((message) => message.id === botMsg.id);
    if (updated?.status === "done" && updated.image) {
      state.storyboard.anchors[index].image = updated.image;
      state.storyboard.anchors[index].messageId = updated.id;
      state.storyboard.anchors[index].status = "done";
      state.storyboard.anchors[index].error = "";
      generated.push(updated.image);
      renderStoryboardAnchors();
      continue;
    }
    const error = updated?.error || "核心参考图生成失败";
    state.storyboard.anchors[index].status = "error";
    state.storyboard.anchors[index].error = error;
    renderStoryboardAnchors();
    throw new Error(error);
  }
  return generated;
}

async function ensureStoryboardRun(anchorBlock) {
  const existingRun = state.storyboard.run;
  const existingConv = existingRun ? state.conversations.find((conv) => conv.id === existingRun.convId) : null;
  const existingFolder = existingRun ? state.galleryFolders.find((folder) => folder.id === existingRun.folderId) : null;
  if (existingConv && existingFolder) return { conv: existingConv, folder: existingFolder };

  const folderName = $("#storyboard-folder-name").value.trim() || state.storyboard.title || `连续出图 ${fmtTime(now())}`;
  const folder = await createGalleryFolder(folderName);
  const conv = await createConversation(`连续出图 · ${folderName}`);
  const story = $("#storyboard-story").value.trim();
  await addMessage({
    role: "user",
    conversationId: conv.id,
    text: `连续出图：${folderName}\n\n${story}\n\n核心设定：\n${anchorBlock}\n\n流程：先生成核心参考图，再引用这些图片生成剧情分镜。`,
    images: [],
    params: getParams(),
    seed: getSeed(),
    status: "done",
  });
  state.storyboard.run = { convId: conv.id, folderId: folder.id, folderName };
  return { conv, folder };
}

async function generateStoryboardReferences() {
  const anchors = currentStoryboardAnchors();
  if (!anchors.length) {
    toast("先添加角色或核心主题");
    return;
  }
  const anchorBlock = storyboardAnchorBlock(anchors);
  state.storyboard.busy = "refs";
  updateStoryboardControls("refs");
  $("#storyboard-status").textContent = "正在生成核心参考图...";
  try {
    const { conv, folder } = await ensureStoryboardRun(anchorBlock);
    renderAll();
    const referenceImages = await generateStoryboardAnchorImages(conv, folder, anchors);
    $("#storyboard-status").textContent = `已生成 ${referenceImages.length} 张核心参考图。确认满意后继续生成剧情图。`;
  } catch (error) {
    $("#storyboard-status").textContent = error.message || "核心参考图生成失败";
    toast(error.message || "核心参考图生成失败");
  } finally {
    state.storyboard.busy = "";
    updateStoryboardControls();
  }
}

function renderStoryboardFrames() {
  const list = $("#storyboard-frame-list");
  list.innerHTML = "";
  state.storyboard.frames.forEach((frame, index) => {
    const row = document.createElement("div");
    row.className = "frame-card";
    row.innerHTML = `
      <div class="frame-head">
        <strong>${String(index + 1).padStart(2, "0")} · ${escapeHtml(frame.title || `画面 ${index + 1}`)}</strong>
        <span>${escapeHtml(frame.beat || "")}</span>
      </div>
      <textarea data-frame-index="${index}" rows="5">${escapeHtml(frame.prompt || "")}</textarea>
    `;
    $("textarea", row).addEventListener("input", (event) => {
      state.storyboard.frames[index].prompt = event.target.value;
      updateStoryboardControls();
    });
    list.appendChild(row);
  });
}

async function startStoryboardGeneration() {
  const frames = storyboardFrameItems();
  if (!frames.length) {
    toast("没有可生成的分镜");
    return;
  }
  const anchors = currentStoryboardAnchors();
  if (!anchors.length) {
    toast("先创建核心设定");
    return;
  }
  if (!storyboardHasAllReferences(anchors)) {
    toast("先生成核心参考图");
    updateStoryboardControls("refs");
    return;
  }
  const anchorBlock = storyboardAnchorBlock(anchors);
  const referenceImages = storyboardReferenceImages(anchors);
  state.storyboard.busy = "frames";
  updateStoryboardControls("frames");
  try {
    const { conv, folder } = await ensureStoryboardRun(anchorBlock);
    $("#storyboard-status").textContent = `已引用 ${referenceImages.length} 张核心参考图，开始生成剧情分镜。`;
    closeModal("storyboard-modal");
    renderAll();

    for (const frame of frames) {
      const frameImages = frameReferenceImages(frame, anchors, 3);
      const prompt = [
        `【连续出图 ${frame.index}/${frames.length}】${frame.title || `画面 ${frame.index}`}`,
        `已附加 ${frameImages.length} 张相关核心参考图。生成时必须参考这些图片中的角色、对象、场景或主题，不要重新发明外观。`,
        "【核心设定，所有画面必须严格遵守】",
        anchorBlock,
        frame.beat ? `剧情节点：${frame.beat}` : "",
        frame.prompt,
        "保持核心设定中的人物、对象、场景、光线和色调连续。不要改变角色身份、服装标志、核心道具形状或主题视觉符号。不要添加无关主体。",
      ].filter(Boolean).join("\n");
      const botMsg = await addMessage({
        role: "bot",
        conversationId: conv.id,
        sourcePrompt: frame.prompt,
        requestPrompt: expandAssets(prompt),
        images: frameImages.length ? frameImages : referenceImages.slice(0, 3),
        params: getParams(),
        seed: getSeed(),
        folderId: folder.id,
        status: "pending",
        logs: [`连续出图 ${frame.index}/${frames.length} 已排队`],
        progress: { label: `准备生成第 ${frame.index}/${frames.length} 张`, percent: 8 },
      });
      renderChat();
      await runGeneration(botMsg.id);
      const updated = state.messages.find((message) => message.id === botMsg.id);
      if (updated && updated.status === "error" && /quota|额度|billing|密钥|key/i.test(updated.error || "")) {
        toast("连续出图已停止：接口配置或额度不可用");
        break;
      }
    }
    state.activeGalleryFolderId = folder.id;
    renderFolderList();
    renderGallery();
  } catch (error) {
    toast(error.message || "剧情图生成失败");
  } finally {
    state.storyboard.busy = "";
    updateStoryboardControls();
  }
}

function openModal(id) {
  $(`#${id}`).classList.remove("hidden");
}

function closeModal(id) {
  $(`#${id}`).classList.add("hidden");
}

function applySettingsToModal() {
  enforceStandardModel();
  $("#setting-api-base").value = state.settings.apiBase || "";
  $("#setting-timeout").value = String(state.settings.timeoutMs || 0);
  $("#setting-retries").value = String(state.settings.retries || 0);
  const select = $("#setting-model");
  select.innerHTML = "";
  const models = allowedImageModels();
  for (const model of models) {
    const opt = document.createElement("option");
    opt.value = model.id;
    const label = modelLabel(model.id, model);
    opt.textContent = label.name;
    opt.title = label.desc;
    select.appendChild(opt);
  }
  select.value = STANDARD_IMAGE_MODEL;
  select.disabled = true;
  const enhanceSelect = $("#setting-enhance-model");
  enhanceSelect.innerHTML = "";
  normalizeEnhanceModelSetting();
  for (const model of allowedEnhanceModels()) {
    const opt = document.createElement("option");
    opt.value = model.id;
    const label = enhanceModelLabel(model.id, model);
    opt.textContent = label.name;
    opt.title = label.desc;
    enhanceSelect.appendChild(opt);
  }
  enhanceSelect.value = selectedEnhanceModel();
  enhanceSelect.disabled = false;
  $("#settings-note").textContent = state.config?.hasKey
    ? "后端已从本地环境读取密钥；生成通道仅开放标准生成，LLM 优化模型可选择。"
    : "后端没有读取到密钥。请在项目 .env、工作区 .env 或技能配置文件中补齐访问凭据。";
}

function saveSettingsFromModal() {
  state.settings.apiBase = $("#setting-api-base").value.trim();
  state.settings.model = STANDARD_IMAGE_MODEL;
  state.settings.enhanceModel = $("#setting-enhance-model").value || DEFAULT_ENHANCE_MODEL;
  state.settings.timeoutMs = Number($("#setting-timeout").value || 0);
  state.settings.retries = Number($("#setting-retries").value || 0);
  saveSettingsLocal();
  renderModelMenu();
  updateParamSummary();
  closeModal("settings-modal");
}

function updateParamSummary() {
  $("#params-label").textContent = `${$("#param-size").value} · ${$("#param-quality").value} · ${$("#param-format").value} · LLM ${enhanceModelLabel(selectedEnhanceModel()).name}`;
  const seed = getSeed();
  $("#seed-label").textContent = seed ? String(seed) : "无";
}

async function saveAsset() {
  const name = $("#asset-name").value.trim().replace(/^@/, "");
  const desc = $("#asset-desc").value.trim();
  const type = $("#asset-type").value;
  if (!name || !desc) {
    toast("名称和描述都需要填写");
    return;
  }
  const asset = { id: uid("asset"), projectId: state.currentProjectId, name, desc, type, createdAt: now(), updatedAt: now() };
  const saved = await put("assets", asset);
  state.assets.unshift(saved);
  $("#asset-name").value = "";
  $("#asset-desc").value = "";
  renderAssets();
}

function bindEvents() {
  bindOptionChips();
  $$("[data-auth-mode]").forEach((btn) => {
    btn.onclick = () => setAuthMode(btn.dataset.authMode);
  });
  $("#auth-send-code-btn").onclick = sendAuthCode;
  $("#auth-submit-btn").onclick = submitAuthCode;
  $("#auth-email").addEventListener("input", () => {
    if (state.auth.emailSent && authEmail() !== state.auth.pendingEmail) {
      state.auth.emailSent = false;
      $("#auth-code").value = "";
      renderAuthForm();
    }
  });
  $("#auth-email").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      if (state.auth.emailSent) submitAuthCode();
      else sendAuthCode();
    }
  });
  $("#auth-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitAuthCode();
  });
  $("#project-select").onchange = (event) => switchProject(event.target.value);
  $("#manage-projects-btn").onclick = () => {
    $("#project-name-input").value = "";
    $("#project-desc-input").value = "";
    delete $("#save-project-btn").dataset.editProjectId;
    $("#save-project-btn").textContent = "新建项目";
    renderProjectList();
    openModal("projects-modal");
  };
  $("#save-project-btn").onclick = saveProjectFromModal;
  $("#new-conversation-btn").onclick = () => createConversation();
  $("#new-folder-btn").onclick = () => {
    $("#folder-name-input").value = "";
    openModal("folder-create-modal");
    setTimeout(() => $("#folder-name-input").focus(), 0);
  };
  $("#confirm-create-folder-btn").onclick = async () => {
    const name = $("#folder-name-input").value.trim();
    if (!name) {
      toast("请输入文件夹名称");
      return;
    }
    const folder = await createGalleryFolder(name);
    state.activeGalleryFolderId = folder.id;
    closeModal("folder-create-modal");
    renderFolderList();
    renderGallery();
  };
  $("#folder-name-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("#confirm-create-folder-btn").click();
  });
  $("#toggle-sidebar-btn").onclick = () => setSidebarOpen(!$("#sidebar").classList.contains("open"));
  $("#sidebar-scrim").onclick = () => setSidebarOpen(false);
  $("#favorites-toggle").onclick = () => $("#favorites-list").classList.toggle("collapsed");
  $("#clear-gallery-btn").onclick = async () => {
    if (!confirm("清空图库？")) return;
    await clearStore("gallery");
    state.gallery = [];
    renderGallery();
  };
  $("#model-button").onclick = () => $("#model-menu").classList.toggle("hidden");
  $("#open-settings-btn").onclick = () => {
    applySettingsToModal();
    openModal("settings-modal");
  };
  $("#open-admin-btn").onclick = openAdminModal;
  $("#refresh-admin-btn").onclick = () => loadAdminUsers();
  $("#admin-save-quota-btn").onclick = () => saveAdminQuota(false);
  $("#admin-reset-used-btn").onclick = () => saveAdminQuota(true);
  $("#logout-btn").onclick = logoutCurrentUser;
  $("#save-settings-btn").onclick = saveSettingsFromModal;
  $("#send-btn").onclick = sendMessage;
  $("#prompt-input").addEventListener("input", autoresizePrompt);
  $("#prompt-input").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendMessage();
  });
  $("#toggle-seed-btn").onclick = () => $("#seed-row").classList.toggle("hidden");
  $("#toggle-params-btn").onclick = () => $("#params-row").classList.toggle("hidden");
  $$(".seed-option").forEach((btn) => {
    btn.onclick = () => {
      $$(".seed-option").forEach((item) => item.classList.remove("active"));
      btn.classList.add("active");
      $("#custom-seed").value = "";
      updateParamSummary();
    };
  });
  $("#custom-seed").addEventListener("input", () => {
    $$(".seed-option").forEach((item) => item.classList.remove("active"));
    updateParamSummary();
  });
  ["param-size", "param-quality", "param-format", "param-reasoning"].forEach((id) => {
    $(`#${id}`).addEventListener("change", updateParamSummary);
  });
  $("#upload-image-btn").onclick = () => $("#image-file-input").click();
  $("#image-file-input").onchange = async (event) => {
    for (const file of Array.from(event.target.files || [])) {
      addPendingImage(await fileToDataUrl(file));
    }
    event.target.value = "";
  };
  $("#pick-gallery-btn").onclick = openGalleryPicker;
  $("#use-picked-gallery-btn").onclick = usePickedGallery;
  $("#enhance-btn").onclick = enhancePrompt;
  $("#storyboard-btn").onclick = () => {
    renderStoryboardAnchors();
    updateStoryboardControls();
    openModal("storyboard-modal");
  };
  $("#storyboard-plan-btn").onclick = planStoryboard;
  $("#storyboard-reference-btn").onclick = generateStoryboardReferences;
  $("#storyboard-start-btn").onclick = startStoryboardGeneration;
  $("#storyboard-reset-btn").onclick = resetStoryboard;
  $("#storyboard-add-anchor-btn").onclick = addStoryboardAnchor;
  $$("[data-anchor-template]").forEach((btn) => {
    btn.onclick = () => addStoryboardAnchor(btn.dataset.anchorTemplate);
  });
  $("#confirm-edit-generate-btn").onclick = confirmEditGenerate;
  $("#open-mark-from-edit-btn").onclick = () => {
    if (!state.editContext) return;
    openMarkEditor(state.editContext.image, (marked) => {
      state.editContext.image = marked;
      $("#edit-preview").src = marked;
      openModal("edit-modal");
    });
    closeModal("edit-modal");
  };
  $("#open-assets-btn").onclick = () => openModal("assets-modal");
  $("#save-asset-btn").onclick = saveAsset;
  $$("[data-close]").forEach((btn) => {
    btn.onclick = () => closeModal(btn.dataset.close);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      for (const id of ["admin-modal", "settings-modal", "projects-modal", "gallery-picker-modal", "folder-picker-modal", "folder-create-modal", "storyboard-modal", "edit-modal", "mark-modal", "assets-modal"]) closeModal(id);
      setSidebarOpen(false);
      for (const [msgId] of state.activeTasks) {
        const msg = state.messages.find((item) => item.id === msgId);
        if (msg?.status === "pending") {
          cancelTask(msgId);
          break;
        }
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "n") createConversation();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") setSidebarOpen(!$("#sidebar").classList.contains("open"));
  });
  window.addEventListener("resize", () => {
    setAppViewportHeight();
    autoresizePrompt();
  });
  window.visualViewport?.addEventListener("resize", () => {
    setAppViewportHeight();
    autoresizePrompt();
  });
  window.visualViewport?.addEventListener("scroll", setAppViewportHeight);
}

async function initConfig() {
  const res = await fetch("api/config");
  state.config = await readApiJson(res, "配置读取失败");
  if (!state.settings.apiBase) state.settings.apiBase = "";
  enforceStandardModel();
  normalizeEnhanceModelSetting();
  const status = $("#api-status");
  status.textContent = state.config.hasKey ? "配置可用" : "缺少密钥";
  status.className = `api-status ${state.config.hasKey ? "ok" : "bad"}`;
  renderModelMenu();
}

async function init() {
  setAppViewportHeight();
  loadSettingsLocal();
  bindEvents();
  renderAuthForm();
  const authenticated = await initAuth();
  if (authenticated) await loadWorkspaceAfterAuth();
}

init().catch((error) => {
  console.error(error);
  toast(error.message || "初始化失败");
});

/* Mark editor */
function openMarkEditor(src, onSave) {
  state.mark = {
    src,
    onSave,
    image: new Image(),
    shapes: [],
    drawing: null,
    tool: "brush",
    undo: [],
  };
  state.mark.image.onload = () => {
    const canvas = $("#mark-canvas");
    const maxW = Math.min(960, window.innerWidth - 80);
    const maxH = Math.min(620, window.innerHeight - 230);
    let w = state.mark.image.naturalWidth;
    let h = state.mark.image.naturalHeight;
    const scale = Math.min(1, maxW / w, maxH / h);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    openModal("mark-modal");
    drawMarkCanvas();
  };
  state.mark.image.src = src;
}

function drawMarkCanvas() {
  const st = state.mark;
  if (!st) return;
  const canvas = $("#mark-canvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(st.image, 0, 0, canvas.width, canvas.height);
  for (const shape of st.shapes) drawShape(ctx, shape);
  if (st.drawing) drawShape(ctx, st.drawing);
}

function drawShape(ctx, s) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.type === "brush") {
    ctx.beginPath();
    s.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.stroke();
  } else if (s.type === "line" || s.type === "arrow") {
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    if (s.type === "arrow") drawArrow(ctx, s);
  } else if (s.type === "rect") {
    ctx.strokeRect(s.x, s.y, s.w, s.h);
  } else if (s.type === "circle") {
    ctx.beginPath();
    ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawArrow(ctx, s) {
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const len = Math.max(12, s.size * 3);
  ctx.beginPath();
  ctx.moveTo(s.x2, s.y2);
  ctx.lineTo(s.x2 - len * Math.cos(angle - Math.PI / 6), s.y2 - len * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(s.x2, s.y2);
  ctx.lineTo(s.x2 - len * Math.cos(angle + Math.PI / 6), s.y2 - len * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function markPos(event) {
  const canvas = $("#mark-canvas");
  const rect = canvas.getBoundingClientRect();
  const p = event.touches?.[0] || event.changedTouches?.[0] || event;
  return {
    x: (p.clientX - rect.left) * canvas.width / rect.width,
    y: (p.clientY - rect.top) * canvas.height / rect.height,
  };
}

function bindMarkEvents() {
  const canvas = $("#mark-canvas");
  const start = (event) => {
    if (!state.mark || state.mark.tool === "select") return;
    event.preventDefault();
    const p = markPos(event);
    const color = $("#mark-color").value;
    const size = Number($("#mark-size").value || 8);
    state.mark.undo.push(JSON.stringify(state.mark.shapes));
    if (state.mark.tool === "brush") state.mark.drawing = { type: "brush", color, size, points: [p] };
    else state.mark.drawing = { type: state.mark.tool, color, size, x1: p.x, y1: p.y, x2: p.x, y2: p.y, x: p.x, y: p.y, w: 0, h: 0 };
    drawMarkCanvas();
  };
  const move = (event) => {
    if (!state.mark?.drawing) return;
    event.preventDefault();
    const p = markPos(event);
    const s = state.mark.drawing;
    if (s.type === "brush") s.points.push(p);
    else {
      s.x2 = p.x; s.y2 = p.y; s.w = p.x - s.x; s.h = p.y - s.y;
    }
    drawMarkCanvas();
  };
  const end = (event) => {
    if (!state.mark?.drawing) return;
    event.preventDefault();
    state.mark.shapes.push(state.mark.drawing);
    state.mark.drawing = null;
    drawMarkCanvas();
  };
  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  canvas.addEventListener("mouseup", end);
  canvas.addEventListener("mouseleave", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end, { passive: false });
  $$(".mark-tool").forEach((btn) => {
    btn.onclick = () => {
      $$(".mark-tool").forEach((item) => item.classList.remove("active"));
      btn.classList.add("active");
      if (state.mark) state.mark.tool = btn.dataset.tool;
    };
  });
  $("#mark-undo-btn").onclick = () => {
    if (!state.mark?.undo.length) return;
    state.mark.shapes = JSON.parse(state.mark.undo.pop());
    drawMarkCanvas();
  };
  $("#mark-clear-btn").onclick = () => {
    if (!state.mark) return;
    state.mark.undo.push(JSON.stringify(state.mark.shapes));
    state.mark.shapes = [];
    drawMarkCanvas();
  };
  $("#save-mark-btn").onclick = () => {
    if (!state.mark) return;
    drawMarkCanvas();
    const dataUrl = $("#mark-canvas").toDataURL("image/png");
    const cb = state.mark.onSave;
    state.mark = null;
    closeModal("mark-modal");
    cb?.(dataUrl);
  };
}

document.addEventListener("DOMContentLoaded", bindMarkEvents);
