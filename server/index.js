require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { google } = require("googleapis");

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_CONTENT_LIMIT = 4096;
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_MAX_IMAGE_COUNT = 3;
const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_XLSX_BYTES = 10 * 1024 * 1024;
const POLLING_TIMEOUT = 30;

const LEDGER_SHEET_ID = "1zu3ymV9140Gx9J_LMeL7qy9mXm-aeBnl1ExXH7SrQas";
const FINANCE_SHEET_ID = "1fI9WsgLd1oJ9h5A4L34Y7zK4pngM844sHKXeJd5qK0Y";

const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream"
]);

const CREDENTIALS_PATH = path.resolve(__dirname, "credentials.json");
const TOKEN_PATH = path.resolve(__dirname, "token.json");
const HISTORY_DIR = path.resolve(__dirname, "chat_history");

// --- Chat history ---

const HISTORY_TTL_MS = 60 * 60 * 1000; // 1시간
const MAX_HISTORY = 20;
const chatHistories = new Map(); // chatId → { messages: [], lastTs: number }

function loadHistory(chatId) {
  const entry = chatHistories.get(chatId);
  if (!entry) return [];
  if (Date.now() - entry.lastTs > HISTORY_TTL_MS) {
    chatHistories.delete(chatId);
    return [];
  }
  return entry.messages;
}

function addToHistory(chatId, role, text) {
  let entry = chatHistories.get(chatId);
  if (!entry || Date.now() - entry.lastTs > HISTORY_TTL_MS) {
    entry = { messages: [], lastTs: Date.now() };
  }
  entry.messages.push({ role, text });
  entry.messages = entry.messages.slice(-MAX_HISTORY);
  entry.lastTs = Date.now();
  chatHistories.set(chatId, entry);
}

// --- Google Sheets auth ---

function getSheetsClient() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, "http://localhost:3210");
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  oAuth2Client.setCredentials(tokens);
  return google.sheets({ version: "v4", auth: oAuth2Client });
}

async function readSheet(spreadsheetId, range) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function appendToSheet(spreadsheetId, range, rows) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows }
  });
}

async function getSheetNames(spreadsheetId) {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  return meta.data.sheets.map((s) => s.properties.title);
}

// --- Helpers ---

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

function isXlsxDocument(document) {
  if (!document?.file_id) return false;
  if (XLSX_MIME_TYPES.has(document.mime_type)) return true;
  const name = (document.file_name || "").toLowerCase();
  return name.endsWith(".xlsx") || name.endsWith(".xls");
}

// --- Telegram API ---

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

async function sendTelegramReply(botToken, chatId, text, replyToMessageId) {
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

async function downloadTelegramFile(botToken, fileId, maxBytes) {
  const file = await telegramApiRequest(botToken, "getFile", { file_id: fileId });
  if (!file?.file_path) throw new Error("Failed to get file path from Telegram");
  if (typeof file.file_size === "number" && file.file_size > maxBytes) throw new Error("파일이 너무 큽니다");

  const fileResponse = await fetch(`${TELEGRAM_API_BASE}/file/bot${botToken}/${file.file_path}`);
  if (!fileResponse.ok) throw new Error("Failed to download file from Telegram");
  return Buffer.from(await fileResponse.arrayBuffer());
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

// --- xlsx → text ---

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

// --- Gemini API ---

async function callGemini(geminiApiKey, geminiModel, systemPrompt, userParts, history) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

  // 히스토리를 Gemini contents 형식으로 변환
  const contents = [];
  if (Array.isArray(history)) {
    for (const h of history) {
      contents.push({
        role: h.role === "user" ? "user" : "model",
        parts: [{ text: h.text }]
      });
    }
  }
  contents.push({ role: "user", parts: userParts });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 16384 }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API failed (${response.status}): ${errorText.slice(0, 400)}`);
  }

  const payload = await response.json();
  const candidate = payload?.candidates?.[0];
  const parts = candidate?.content?.parts;
  let text = Array.isArray(parts)
    ? parts.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n").trim()
    : "";
  if (candidate?.finishReason === "MAX_TOKENS" && text) {
    text += "\n\n(응답이 길어 잘렸습니다. 더 자세히 알고 싶으면 다시 질문해주세요)";
  }
  return text;
}

// --- xlsx 파일 처리: 파싱 → 가계부 시트에 추가 ---

const XLSX_PARSE_PROMPT = `You are a Korean card payment statement parser.
Parse ALL transactions from the uploaded data.

For each transaction, output a JSON object with these fields:
- 날짜: payment date in "YYYY-MM-DD" format
- 가맹점: merchant/store name
- 카테고리: classify into one of: 식비, 교통, 쇼핑, 생활비, 의료, 교육, 문화/여가, 통신, 유류비, 기타
- 금액: payment amount as a positive integer (no commas, no currency symbol)
- 카드: card name or last 4 digits if available
- 메모: any additional info (installment, approval number, etc.)

Rules:
- Return a JSON array. If no transactions found, return [].
- Return ONLY valid JSON, no markdown, no explanation.
- Ignore summary/total rows, only include individual transactions.`;

async function handleXlsxUpload(botToken, geminiApiKey, geminiModel, message) {
  const chatId = message.chat.id;

  const fileBuffer = await downloadTelegramFile(botToken, message.document.file_id, MAX_XLSX_BYTES);
  const sheetText = xlsxToText(fileBuffer);

  if (!sheetText.trim()) {
    await sendTelegramReply(botToken, chatId, "파일에서 데이터를 읽을 수 없습니다.", message.message_id);
    return;
  }

  // Gemini로 파싱
  const rawResult = await callGemini(geminiApiKey, geminiModel, XLSX_PARSE_PROMPT, [{ text: sheetText }], null);
  const jsonMatch = rawResult.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    await sendTelegramReply(botToken, chatId, "지출 내역을 파싱할 수 없습니다.", message.message_id);
    return;
  }

  let transactions;
  try {
    transactions = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(transactions) || transactions.length === 0) {
      await sendTelegramReply(botToken, chatId, "지출 내역을 찾을 수 없습니다.", message.message_id);
      return;
    }
  } catch {
    await sendTelegramReply(botToken, chatId, "파싱 결과를 해석할 수 없습니다.", message.message_id);
    return;
  }

  // 시트에 추가할 행 만들기
  const rows = transactions
    .filter((tx) => tx.날짜 && tx.금액)
    .map((tx) => [
      String(tx.날짜 || ""),
      String(tx.가맹점 || ""),
      String(tx.카테고리 || "기타"),
      Number(tx.금액) || 0,
      String(tx.카드 || ""),
      String(tx.메모 || "")
    ]);

  if (rows.length === 0) {
    await sendTelegramReply(botToken, chatId, "유효한 지출 내역이 없습니다.", message.message_id);
    return;
  }

  // 현재 연도 시트에 추가
  const year = String(rows[0][0]).slice(0, 4) || new Date().getFullYear().toString();
  await appendToSheet(LEDGER_SHEET_ID, `${year}!A:F`, rows);

  const total = rows.reduce((sum, r) => sum + (Number(r[3]) || 0), 0);
  const lines = [
    `지출내역 ${rows.length}건 가계부에 저장 완료`,
    `총 금액: ${total.toLocaleString("ko-KR")}원`,
    "",
    "--- 상세 (최대 20건) ---"
  ];
  for (const r of rows.slice(0, 20)) {
    lines.push(`${r[0]} | ${r[1]} | ${Number(r[3]).toLocaleString("ko-KR")}원 | ${r[2]}`);
  }
  if (rows.length > 20) lines.push(`... 외 ${rows.length - 20}건`);

  await sendTelegramReply(botToken, chatId, lines.join("\n"), message.message_id);
}

// --- 일반 메시지 처리: 시트 데이터 참조하여 응답 ---

const SYSTEM_PROMPT = `You are a helpful family finance assistant for Telegram chat. Reply in Korean.

You have access to two Google Spreadsheets:

1. "호미 가계부" - 상세 지출 내역 (컬럼: 날짜, 가맹점, 카테고리, 금액, 카드, 메모)
2. "재무재표" - 월별 수입/지출 요약, 자산 현황, 생활비 내역 등

사용자가 지출, 가계부, 재무 관련 질문을 하면 아래 제공된 시트 데이터를 기반으로 정확하게 답변하세요.
재무와 무관한 일반 질문에는 평소처럼 답변하면 됩니다.

응답 형식 규칙:
- Markdown 문법(*, **, #, - 등)을 절대 사용하지 마세요.
- 텔레그램에 맞게 일반 텍스트로 작성하세요.
- 구분이 필요하면 줄바꿈과 이모지를 활용하세요.
- 이모지는 적절히 사용해도 좋습니다 (💰📊🏷️ 등).
- 목록은 이모지나 숫자로 표현하세요 (예: "1. ", "📌 ").
- 금액은 천 단위 쉼표를 포함하세요 (예: 1,234,000원).
- 반드시 간결하게 답변하세요. 핵심 요약 위주로 짧게 작성하세요.
- 전체 항목을 나열하지 말고, 카테고리별 합계나 상위 항목 위주로 요약하세요.
- 사용자가 상세 내역을 요청할 때만 세부 항목을 나열하세요.`;

async function loadSheetContext() {
  const lines = [];

  try {
    // 호미 가계부 - 현재 연도
    const year = new Date().getFullYear().toString();
    const ledgerRows = await readSheet(LEDGER_SHEET_ID, `${year}!A:F`);
    if (ledgerRows.length > 0) {
      // 헤더 + 최근 100건
      const header = ledgerRows[0];
      const recent = ledgerRows.slice(-100);
      lines.push(`\n[호미 가계부 - ${year}년] (총 ${ledgerRows.length - 1}건, 최근 100건 표시)`);
      lines.push(header.join(" | "));
      for (const row of recent) {
        lines.push(row.join(" | "));
      }
    }
  } catch (err) {
    console.warn("Failed to read ledger sheet", err.message);
  }

  try {
    // 재무재표 - 현재 연도 시트
    const year = new Date().getFullYear().toString();
    const financeRows = await readSheet(FINANCE_SHEET_ID, `${year}!A:Z`);
    if (financeRows.length > 0) {
      lines.push(`\n[재무재표 - ${year}년]`);
      for (const row of financeRows) {
        lines.push(row.join(" | "));
      }
    }
  } catch (err) {
    console.warn("Failed to read finance sheet", err.message);
  }

  return lines.join("\n");
}

async function handleTextMessage(botToken, geminiApiKey, geminiModel, message) {
  const chatId = message.chat.id;
  const messageText = String(message?.text || message?.caption || "").trim();
  const maxImageCount = parsePositiveInt(process.env.TELEGRAM_MAX_IMAGE_COUNT, DEFAULT_MAX_IMAGE_COUNT);
  const maxImageBytes = parsePositiveInt(process.env.TELEGRAM_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES);
  const imageInputs = buildImageInputs(message, maxImageCount);

  if (!messageText && imageInputs.length === 0) return;

  // 이미지 다운로드
  const imageParts = [];
  for (const image of imageInputs) {
    try {
      const part = await downloadTelegramImagePart(botToken, image, maxImageBytes);
      if (part) imageParts.push(part);
    } catch (err) {
      console.warn("Image download skipped", err.message);
    }
  }

  // 시트 데이터 로드
  const sheetContext = await loadSheetContext();

  const userPrompt = [
    `User: ${getSenderName(message)}`,
    messageText ? `Message: ${messageText}` : "Message: (no text)",
    sheetContext ? `\n--- 스프레드시트 데이터 ---${sheetContext}` : ""
  ].filter(Boolean).join("\n");

  // 히스토리 로드 & 현재 메시지 추가
  const history = loadHistory(chatId);
  addToHistory(chatId, "user", messageText || "(이미지)");

  const answer = await callGemini(geminiApiKey, geminiModel, SYSTEM_PROMPT, [{ text: userPrompt }, ...imageParts], history);
  addToHistory(chatId, "model", answer);

  await sendTelegramReply(botToken, chatId, answer || "응답을 생성할 수 없습니다.", message.message_id);
}

// --- 메시지 핸들러 ---

async function handleMessage(botToken, geminiApiKey, message) {
  const chatId = message?.chat?.id;
  if (typeof chatId !== "number") return;
  if (message?.from?.is_bot) return;

  const allowedChatIds = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? process.env.TELEGRAM_ALLOWED_CHAT_ID);
  if (allowedChatIds.size > 0 && !allowedChatIds.has(String(chatId))) return;

  const geminiModel = (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();

  try {
    await telegramApiRequest(botToken, "sendChatAction", { chat_id: chatId, action: "typing" });

    if (isXlsxDocument(message?.document)) {
      await handleXlsxUpload(botToken, geminiApiKey, geminiModel, message);
    } else {
      await handleTextMessage(botToken, geminiApiKey, geminiModel, message);
    }
  } catch (error) {
    console.error("Message handling failed", error);
    try {
      await sendTelegramReply(botToken, chatId, "요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.", message.message_id);
    } catch (replyError) {
      console.error("Fallback reply failed", replyError);
    }
  }
}

// --- Long polling ---

async function poll() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();

  if (!botToken || !geminiApiKey) {
    console.error("TELEGRAM_BOT_TOKEN or GEMINI_API_KEY missing in .env");
    process.exit(1);
  }

  await telegramApiRequest(botToken, "deleteWebhook", { drop_pending_updates: false });
  console.log("Webhook deleted. Starting long polling...");

  let offset = 0;

  while (true) {
    try {
      const updates = await telegramApiRequest(botToken, "getUpdates", {
        offset,
        timeout: POLLING_TIMEOUT,
        allowed_updates: ["message", "channel_post"]
      });

      if (Array.isArray(updates)) {
        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message || update.channel_post;
          if (message) {
            handleMessage(botToken, geminiApiKey, message).catch((err) =>
              console.error("Unhandled error in handleMessage", err)
            );
          }
        }
      }
    } catch (error) {
      console.error("Polling error, retrying in 5s...", error.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

poll();
