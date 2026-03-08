const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const XLSX = require("xlsx");

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_CONTENT_LIMIT = 4096;
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_MAX_IMAGE_COUNT = 3;
const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const PROCESSED_UPDATE_TTL_MS = 10 * 60 * 1000;
const MAX_XLSX_BYTES = 10 * 1024 * 1024;
const GITHUB_API_BASE = "https://api.github.com";
const CSV_HEADER = "date,category,detail,amount,cardName,memo";

const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream"
]);

const LEDGER_PARSE_PROMPT = `You are a Korean card payment statement parser.
The user uploaded an xlsx card statement. Parse ALL transactions from the text below.

For each transaction, output a JSON object with these fields:
- date: payment date in "YYYY-MM-DD" format
- flowType: always "expense"
- category: classify into one of: 식비, 교통, 쇼핑, 생활비, 의료, 교육, 문화/여가, 통신, 유류비, 기타
- detail: merchant/store name (가맹점명)
- amount: payment amount as a positive integer (no commas, no currency symbol)
- cardName: card name or last 4 digits if available
- memo: any additional info (installment, approval number, etc.)

Rules:
- If there are multiple transactions, return an array.
- If no transactions found, return an empty array [].
- Return ONLY valid JSON, no markdown, no explanation.
- Amount must be a positive integer in KRW.
- Ignore summary/total rows, only include individual transactions.

Statement data:
{sheetText}`;

const processedUpdateIds = new Map();

function parsePositiveInt(rawValue, fallback) {
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowedChatIds(rawValue) {
  const ids = String(rawValue || "").split(",").map((id) => id.trim()).filter(Boolean);
  return new Set(ids);
}

function toTelegramChunks(text) {
  const content = String(text || "").trim() || "No response was generated.";
  if (content.length <= TELEGRAM_CONTENT_LIMIT) return [content];

  const chunks = [];
  let cursor = 0;
  while (cursor < content.length) {
    const window = content.slice(cursor, cursor + TELEGRAM_CONTENT_LIMIT);
    const breakIndex = window.lastIndexOf("\n");
    const useBreak = breakIndex > TELEGRAM_CONTENT_LIMIT * 0.6;
    const chunk = useBreak ? window.slice(0, breakIndex) : window;
    chunks.push(chunk);
    cursor += chunk.length;
    while (content[cursor] === "\n" || content[cursor] === " ") cursor += 1;
  }
  return chunks;
}

function cleanupProcessedUpdateIds() {
  const now = Date.now();
  for (const [updateId, timestamp] of processedUpdateIds.entries()) {
    if (now - timestamp > PROCESSED_UPDATE_TTL_MS) processedUpdateIds.delete(updateId);
  }
}

function isDuplicateUpdate(updateId) {
  if (typeof updateId !== "number") return false;
  cleanupProcessedUpdateIds();
  if (processedUpdateIds.has(updateId)) return true;
  processedUpdateIds.set(updateId, Date.now());
  return false;
}

function getPrimaryPhoto(photos) {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  return photos.reduce((best, current) => {
    if (!current || !current.file_id) return best;
    if (!best) return current;
    const bestSize = typeof best.file_size === "number" && best.file_size > 0
      ? best.file_size : (best.width || 0) * (best.height || 0);
    const currentSize = typeof current.file_size === "number" && current.file_size > 0
      ? current.file_size : (current.width || 0) * (current.height || 0);
    return currentSize > bestSize ? current : best;
  }, null);
}

function buildImageInputs(message, maxImageCount) {
  const images = [];
  const photo = getPrimaryPhoto(message?.photo);
  if (photo?.file_id) {
    images.push({ fileId: photo.file_id, declaredSize: typeof photo.file_size === "number" ? photo.file_size : null, mimeType: "image/jpeg" });
  }
  const document = message?.document;
  if (document?.file_id && document?.mime_type?.startsWith("image/")) {
    images.push({ fileId: document.file_id, declaredSize: typeof document.file_size === "number" ? document.file_size : null, mimeType: document.mime_type });
  }
  return images.slice(0, maxImageCount);
}

function getSenderName(message) {
  const first = message?.from?.first_name?.trim();
  const last = message?.from?.last_name?.trim();
  const fullName = [first, last].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  const username = message?.from?.username?.trim();
  if (username) return username;
  const senderChatTitle = message?.sender_chat?.title?.trim();
  if (senderChatTitle) return senderChatTitle;
  return "telegram-user";
}

function buildPromptText(senderName, messageText, imageCount, skippedImageCount) {
  const lines = [
    `User: ${senderName}`,
    messageText ? `Message: ${messageText}` : "Message: (no text)",
    `Attached images: ${imageCount}`
  ];
  if (skippedImageCount > 0) lines.push(`Skipped image files: ${skippedImageCount} (unsupported or too large)`);
  lines.push("Respond helpfully to this Telegram message.");
  return lines.join("\n");
}

async function telegramApiRequest(botToken, method, body) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API failed (${method}, ${response.status}): ${errorText.slice(0, 400)}`);
  }
  const payload = await response.json();
  if (!payload?.ok) {
    throw new Error(`Telegram API returned error (${method}): ${String(payload?.description || "unknown").slice(0, 400)}`);
  }
  return payload?.result;
}

async function downloadTelegramImagePart(botToken, image, maxImageBytes) {
  if (image.declaredSize && image.declaredSize > maxImageBytes) return null;
  const file = await telegramApiRequest(botToken, "getFile", { file_id: image.fileId });
  if (!file?.file_path) return null;
  if (typeof file.file_size === "number" && file.file_size > maxImageBytes) return null;

  const fileResponse = await fetch(`${TELEGRAM_API_BASE}/file/bot${botToken}/${file.file_path}`, { method: "GET" });
  if (!fileResponse.ok) return null;

  const contentLength = Number.parseInt(fileResponse.headers.get("content-length") || "0", 10);
  if (Number.isFinite(contentLength) && contentLength > maxImageBytes) return null;

  const raw = Buffer.from(await fileResponse.arrayBuffer());
  if (raw.length > maxImageBytes) return null;

  const headerMimeType = fileResponse.headers.get("content-type") || "";
  const mimeType = headerMimeType.startsWith("image/") ? headerMimeType : image.mimeType || "image/jpeg";
  return { inlineData: { mimeType, data: raw.toString("base64") } };
}

async function askGemini(botToken, geminiApiKey, geminiModel, senderName, messageText, imageInputs, maxImageBytes) {
  const imageParts = [];
  for (const image of imageInputs) {
    try {
      const imagePart = await downloadTelegramImagePart(botToken, image, maxImageBytes);
      if (imagePart) imageParts.push(imagePart);
    } catch (error) {
      logger.warn("Image download skipped", { error: String(error) });
    }
  }

  const prompt = buildPromptText(senderName, messageText, imageParts.length, Math.max(imageInputs.length - imageParts.length, 0));
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: "You are a helpful assistant for Telegram chat. Reply in Korean unless asked otherwise." }] },
      contents: [{ role: "user", parts: [{ text: prompt }, ...imageParts] }],
      generationConfig: { maxOutputTokens: 700 }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API failed (${response.status}): ${errorText.slice(0, 400)}`);
  }

  const payload = await response.json();
  const parts = payload?.candidates?.[0]?.content?.parts;
  const outputText = Array.isArray(parts)
    ? parts.map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n").trim()
    : "";
  return outputText || "No response was generated.";
}

function isXlsxDocument(document) {
  if (!document?.file_id) return false;
  if (XLSX_MIME_TYPES.has(document.mime_type)) return true;
  const name = (document.file_name || "").toLowerCase();
  return name.endsWith(".xlsx") || name.endsWith(".xls");
}

async function downloadTelegramFile(botToken, fileId) {
  const file = await telegramApiRequest(botToken, "getFile", { file_id: fileId });
  if (!file?.file_path) throw new Error("Failed to get file path from Telegram");
  if (typeof file.file_size === "number" && file.file_size > MAX_XLSX_BYTES) throw new Error("파일이 너무 큽니다 (최대 10MB)");

  const fileResponse = await fetch(`${TELEGRAM_API_BASE}/file/bot${botToken}/${file.file_path}`);
  if (!fileResponse.ok) throw new Error("Failed to download file from Telegram");
  return Buffer.from(await fileResponse.arrayBuffer());
}

function xlsxToText(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheets = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) sheets.push(`[${name}]\n${csv}`);
  }
  return sheets.join("\n\n").slice(0, 12000);
}

async function parseXlsxWithGemini(geminiApiKey, geminiModel, sheetText) {
  const prompt = LEDGER_PARSE_PROMPT.replace("{sheetText}", sheetText);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 4000, temperature: 0.1 }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API failed (${response.status}): ${errorText.slice(0, 400)}`);
  }

  const payload = await response.json();
  const parts = payload?.candidates?.[0]?.content?.parts;
  const outputText = Array.isArray(parts) ? parts.map((p) => p?.text || "").join("") : "";
  const jsonMatch = outputText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    logger.warn("Failed to parse Gemini JSON", { output: jsonMatch[0].slice(0, 500) });
    return [];
  }
}

// --- CSV helpers ---

function escapeCsvField(value) {
  const str = String(value || "").replace(/"/g, '""');
  return str.includes(",") || str.includes('"') || str.includes("\n") ? `"${str}"` : str;
}

function transactionToCsvRow(tx) {
  const date = String(tx.date || "").trim();
  const amount = Number(tx.amount);
  if (!date.match(/^\d{4}-\d{2}-\d{2}$/) || !Number.isFinite(amount) || amount <= 0) return null;

  return [
    date,
    escapeCsvField(String(tx.category || "기타").trim()),
    escapeCsvField(String(tx.detail || "").trim()),
    Math.abs(Math.trunc(amount)),
    escapeCsvField(String(tx.cardName || "").trim()),
    escapeCsvField(String(tx.memo || "").trim())
  ].join(",");
}

function groupTransactionsByYear(transactions) {
  const groups = {};
  for (const tx of transactions) {
    const row = transactionToCsvRow(tx);
    if (!row) continue;
    const year = String(tx.date).slice(0, 4);
    if (!groups[year]) groups[year] = [];
    groups[year].push(row);
  }
  return groups;
}

// --- GitHub API helpers ---

async function githubApiRequest(token, method, path, body) {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (method === "GET" && response.status === 404) return null;

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API failed (${method} ${path}, ${response.status}): ${errorText.slice(0, 400)}`);
  }

  return response.json();
}

async function getFileFromGitHub(token, repo, filePath) {
  const result = await githubApiRequest(token, "GET", `/repos/${repo}/contents/${encodeURIComponent(filePath)}`);
  if (!result) return null;
  const content = Buffer.from(result.content, "base64").toString("utf-8");
  return { content, sha: result.sha };
}

async function putFileToGitHub(token, repo, filePath, content, message, sha) {
  const encoded = Buffer.from(content, "utf-8").toString("base64");
  const body = { message, content: encoded };
  if (sha) body.sha = sha;
  return githubApiRequest(token, "PUT", `/repos/${repo}/contents/${encodeURIComponent(filePath)}`, body);
}

async function saveLedgerToGitHub(token, repo, transactions) {
  const grouped = groupTransactionsByYear(transactions);
  const years = Object.keys(grouped);
  if (years.length === 0) return 0;

  let totalSaved = 0;

  for (const year of years) {
    const newRows = grouped[year];
    const filePath = `가계부/${year}/data.csv`;
    const existing = await getFileFromGitHub(token, repo, filePath);

    let csvContent;
    if (existing && existing.content.trim()) {
      // append new rows to existing CSV (skip header if already present)
      const existingContent = existing.content.trimEnd();
      csvContent = existingContent + "\n" + newRows.join("\n") + "\n";
    } else {
      csvContent = CSV_HEADER + "\n" + newRows.join("\n") + "\n";
    }

    const commitMessage = `가계부: ${year}년 카드내역 ${newRows.length}건 추가`;
    await putFileToGitHub(token, repo, filePath, csvContent, commitMessage, existing?.sha || null);
    totalSaved += newRows.length;
  }

  return totalSaved;
}

// --- Telegram reply ---

async function sendTelegramReply(botToken, message, text) {
  const chatId = message?.chat?.id;
  const replyToMessageId = message?.message_id;
  if (typeof chatId !== "number") return;

  const chunks = toTelegramChunks(text);
  for (let index = 0; index < chunks.length; index += 1) {
    await telegramApiRequest(botToken, "sendMessage", {
      chat_id: chatId,
      text: chunks[index],
      reply_to_message_id: index === 0 ? replyToMessageId : undefined,
      allow_sending_without_reply: true
    });
  }
}

// --- Webhook handler ---

exports.telegramWebhook = onRequest(
  { region: "us-central1", timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method Not Allowed" });
      return;
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
    if (!botToken || !geminiApiKey) {
      res.status(500).json({ ok: false, error: "TELEGRAM_BOT_TOKEN or GEMINI_API_KEY missing" });
      return;
    }

    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (expectedSecret) {
      const providedSecret = req.header("x-telegram-bot-api-secret-token");
      if (!providedSecret || providedSecret !== expectedSecret) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
    }

    const update = req.body && typeof req.body === "object" ? req.body : null;
    if (!update) {
      res.status(400).json({ ok: false, error: "Invalid JSON payload" });
      return;
    }

    if (isDuplicateUpdate(update.update_id)) {
      res.status(200).json({ ok: true });
      return;
    }

    const message = update.message || update.channel_post;
    if (!message) { res.status(200).json({ ok: true }); return; }
    if (message?.from?.is_bot) { res.status(200).json({ ok: true }); return; }

    const chatId = message?.chat?.id;
    if (typeof chatId !== "number") { res.status(200).json({ ok: true }); return; }

    const allowedChatIds = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? process.env.TELEGRAM_ALLOWED_CHAT_ID);
    if (allowedChatIds.size > 0 && !allowedChatIds.has(String(chatId))) {
      res.status(200).json({ ok: true });
      return;
    }

    // --- xlsx → parse → save to git as CSV ---
    if (isXlsxDocument(message?.document)) {
      const geminiModel = (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
      const githubToken = process.env.GITHUB_TOKEN?.trim();
      const githubRepo = process.env.GITHUB_REPO?.trim();

      if (!githubToken || !githubRepo) {
        await sendTelegramReply(botToken, message, "GITHUB_TOKEN 또는 GITHUB_REPO가 설정되지 않았습니다.");
        res.status(200).json({ ok: true });
        return;
      }

      try {
        await telegramApiRequest(botToken, "sendChatAction", { chat_id: chatId, action: "typing" });

        const fileBuffer = await downloadTelegramFile(botToken, message.document.file_id);
        const sheetText = xlsxToText(fileBuffer);

        if (!sheetText.trim()) {
          await sendTelegramReply(botToken, message, "xlsx 파일에서 데이터를 읽을 수 없습니다.");
          res.status(200).json({ ok: true });
          return;
        }

        const transactions = await parseXlsxWithGemini(geminiApiKey, geminiModel, sheetText);

        if (transactions.length === 0) {
          await sendTelegramReply(botToken, message, "카드 결제 내역을 찾을 수 없습니다.");
          res.status(200).json({ ok: true });
          return;
        }

        const savedCount = await saveLedgerToGitHub(githubToken, githubRepo, transactions);

        const total = transactions.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
        const lines = [
          `카드내역 ${savedCount}건 저장 완료 (git)`,
          `총 금액: ${total.toLocaleString("ko-KR")}원`,
          "",
          "--- 상세 (최대 20건) ---"
        ];
        for (const tx of transactions.slice(0, 20)) {
          const amount = Number(tx.amount) || 0;
          lines.push(`${tx.date || "?"} | ${tx.detail || "?"} | ${amount.toLocaleString("ko-KR")}원 | ${tx.category || "기타"}`);
        }
        if (transactions.length > 20) lines.push(`... 외 ${transactions.length - 20}건`);

        await sendTelegramReply(botToken, message, lines.join("\n"));
      } catch (error) {
        logger.error("xlsx processing failed", error);
        await sendTelegramReply(
          botToken, message,
          `xlsx 처리 중 오류가 발생했습니다: ${String(error.message || error).slice(0, 200)}`
        ).catch((e) => logger.error("Fallback reply failed", e));
      }

      res.status(200).json({ ok: true });
      return;
    }

    // --- normal text/image → Gemini ---
    const messageText = String(message?.text || message?.caption || "").trim();
    const maxImageCount = parsePositiveInt(process.env.TELEGRAM_MAX_IMAGE_COUNT, DEFAULT_MAX_IMAGE_COUNT);
    const maxImageBytes = parsePositiveInt(process.env.TELEGRAM_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES);
    const imageInputs = buildImageInputs(message, maxImageCount);

    if (!messageText && imageInputs.length === 0) {
      res.status(200).json({ ok: true });
      return;
    }

    const geminiModel = (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();

    try {
      await telegramApiRequest(botToken, "sendChatAction", { chat_id: chatId, action: "typing" });
      const answer = await askGemini(botToken, geminiApiKey, geminiModel, getSenderName(message), messageText, imageInputs, maxImageBytes);
      await sendTelegramReply(botToken, message, answer);
    } catch (error) {
      logger.error("Telegram webhook failed", error);
      try {
        await sendTelegramReply(botToken, message, "Request failed while processing your message. Please try again shortly.");
      } catch (replyError) {
        logger.error("Telegram fallback reply failed", replyError);
      }
    }

    res.status(200).json({ ok: true });
  }
);
