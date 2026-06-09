import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname);
const publicDir = join(rootDir, "public");
const workspaceDir = resolve(rootDir, "..");
const skillEnvFile = "/Users/chengzhihua/.codex/skills/vsllm-image/.env";
const defaultPort = Number(process.env.PORT || 4173);

const DEFAULT_API_BASE = "https://vsllm.com/v1";
const DEFAULT_IMAGE_MODEL = "gpt-image-2-chat-priority";
const DEFAULT_TOOL_MODEL = "gpt-image-2";
const DEFAULT_ENHANCE_MODEL = "deepseek-v4-pro";

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

function getRuntimeConfig(overrides = {}) {
  const config = loadConfig();
  const apiKey = overrides.apiKey || pick(config, ["VSLLM_API_KEY", "OPENAI_API_KEY", "HF_IMAGE_API_KEY", "key"]);
  const baseUrl = normalizeApiBaseUrl(overrides.apiBase || pick(config, ["VSLLM_API_BASE_URL", "OPENAI_BASE_URL", "HF_IMAGE_API_BASE_URL", "url"], DEFAULT_API_BASE));
  const imageModel = overrides.model || pick(config, ["VSLLM_IMAGE_MODEL", "model", "model1"], DEFAULT_IMAGE_MODEL);
  const toolModel = overrides.toolModel || pick(config, ["VSLLM_IMAGE_TOOL_MODEL"], DEFAULT_TOOL_MODEL);
  const enhanceModel = overrides.enhanceModel || pick(config, ["VSLLM_ENHANCE_MODEL"], DEFAULT_ENHANCE_MODEL);
  return { apiKey, baseUrl, imageModel, toolModel, enhanceModel };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
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
  if (/partial_image/i.test(type || "")) return "收到部分预览图";
  if (/image_generation_call\.completed$/i.test(type || "")) return "图片渲染完成";
  if (/image_generation_call\.in_progress/i.test(type || "")) return "图片渲染中";
  if (/image_generation_call\.generating/i.test(type || "")) return "图片生成中";
  if (/output_item\.added$/i.test(type || "") && item?.type === "image_generation_call") return "开始渲染图片";
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

async function proxyGenerate(req, res) {
  const input = await readJson(req);
  const { cfg, payload, format } = buildImagePayload(input);
  if (!cfg.apiKey) {
    sendJson(res, 400, { error: "missing API key in env" });
    return;
  }

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
      sseSend(res, "error", { status: upstream.status, message });
      res.end();
      return;
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") || !upstream.body) {
      const data = await upstream.json();
      const image = extractImage(data);
      if (!image) {
        sseSend(res, "error", { message: "API 返回成功，但没有找到图片数据" });
      } else {
        sseSend(res, "result", { image, usage: extractUsage(data), elapsedMs: Date.now() - startedAt, format });
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
    let keepaliveTimer = setInterval(() => {
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

    if (failedMessage) {
      res.end();
      return;
    }
    if (!latestImage && finalResponse) {
      latestImage = extractImage(finalResponse);
      latestUsage = latestUsage || extractUsage(finalResponse);
    }
    if (!latestImage) {
      sseSend(res, "error", { message: "流结束，但未能提取图片数据" });
    } else {
      sseSend(res, "result", { image: latestImage, usage: latestUsage, elapsedMs: Date.now() - startedAt, format });
    }
    res.end();
  } catch (error) {
    if (error?.name === "AbortError") return;
    sseSend(res, "error", { message: error?.message || String(error) });
    res.end();
  }
}

async function enhancePrompt(req, res) {
  const input = await readJson(req);
  const cfg = getRuntimeConfig(input || {});
  if (!cfg.apiKey) {
    sendJson(res, 400, { error: "missing API key in env" });
    return;
  }
  const system = [
    'You are a prompt-rewriting assistant for the image model "gpt-image-2", which takes natural-language descriptions, not comma-separated Stable Diffusion tag soup.',
    "Rewrite the user idea into one clear, vivid natural-language image description.",
    "Preserve the user's subject, intent, language, and any @name tokens.",
    "Add useful concrete details: scene, composition, light, materials, camera angle, mood, color, texture, and key props.",
    "Output only the rewritten prompt text. No markdown, no quotes, no explanation.",
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
    let text = data?.choices?.[0]?.message?.content;
    if (Array.isArray(text)) text = text.map((item) => typeof item === "string" ? item : item.text || "").join("");
    text = String(text || "").trim().replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
    sendJson(res, 200, { prompt: text, model: cfg.enhanceModel });
  } catch (error) {
    sendJson(res, 500, { error: error?.message || String(error) });
  }
}

function parseStoryboardJson(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
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
    let content = data?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) content = content.map((item) => typeof item === "string" ? item : item.text || "").join("");
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
  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      const cfg = getRuntimeConfig();
      sendJson(res, 200, {
        hasKey: Boolean(cfg.apiKey),
        apiBase: cfg.baseUrl,
        imageModel: cfg.imageModel,
        toolModel: cfg.toolModel,
        enhanceModel: cfg.enhanceModel,
        models: [
          { id: "gpt-image-2-chat-priority", name: "高速生成", desc: "推荐通道 · 更快更稳 · 成本更高", premium: true },
          { id: "gpt-image-2-chat", name: "标准生成", desc: "经济通道 · 适合日常草稿", premium: false },
        ],
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/generate") {
      await proxyGenerate(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/enhance") {
      await enhancePrompt(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/storyboard") {
      await buildStoryboard(req, res);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      let path = decodeURIComponent(url.pathname);
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
    sendJson(res, 500, { error: error?.message || String(error) });
  }
}

const server = createServer(route);
server.listen(defaultPort, () => {
  console.log(`Image creation workbench running at http://localhost:${defaultPort}`);
});
