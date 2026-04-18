require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");
const XLSX = require("xlsx");
const express = require("express");

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_CONTENT_LIMIT = 4096;
const DEFAULT_MAX_IMAGE_COUNT = 3;
const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_XLSX_BYTES = 10 * 1024 * 1024;
const POLLING_TIMEOUT = 30;

const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream"
]);

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

// --- Claude CLI ---

function callClaude(systemPrompt, userText) {
  const args = ["-p", "--model", "sonnet", "--bare"];
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  const result = execFileSync("claude", args, {
    input: userText,
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf-8",
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024
  }).trim();

  return result;
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

async function handleXlsxUpload(botToken, message) {
  const chatId = message.chat.id;

  const fileBuffer = await downloadTelegramFile(botToken, message.document.file_id, MAX_XLSX_BYTES);
  const sheetText = xlsxToText(fileBuffer);

  if (!sheetText.trim()) {
    await sendTelegramReply(botToken, chatId, "파일에서 데이터를 읽을 수 없습니다.", message.message_id);
    return;
  }

  // Claude로 파싱
  const rawResult = callClaude(XLSX_PARSE_PROMPT, sheetText);
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

  const year = String(rows[0][0]).slice(0, 4) || new Date().getFullYear().toString();

  // 로컬 expense_detail.json에 저장
  const financialDir = path.resolve(__dirname, "../financial");
  const detailPath = path.join(financialDir, "expense_detail.json");
  let detail = {};
  if (fs.existsSync(detailPath)) {
    try { detail = JSON.parse(fs.readFileSync(detailPath, "utf-8")); } catch {}
  }
  if (!detail[year]) detail[year] = {};

  // 월별로 분류하여 저장
  for (const r of rows) {
    const month = String(r[0]).slice(5, 7); // "2026-03" → "03"
    if (!detail[year][month]) detail[year][month] = [];
    detail[year][month].push({
      날짜: r[0], 가맹점: r[1], 카테고리: r[2],
      금액: Number(r[3]) || 0, 카드: r[4], 메모: r[5]
    });
  }

  fs.writeFileSync(detailPath, JSON.stringify(detail, null, 2), "utf-8");

  // Git commit & push
  try {
    execSync(`git add expense_detail.json && git commit -m "지출 상세 내역 업데이트 (${year})" && git push`, {
      cwd: financialDir, stdio: "pipe", timeout: 30000
    });
  } catch (gitErr) {
    console.error("[Expense] Git push failed:", gitErr.message);
  }

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

You have access to family financial data:

1. 재무재표 CSV - 월별 수입/지출/저축 요약, 자산 현황
2. 지출 상세 내역 - 카드 명세서 기반 가맹점별 지출 내역

사용자가 지출, 가계부, 재무 관련 질문을 하면 아래 제공된 데이터를 기반으로 정확하게 답변하세요.
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

function loadCsvContext() {
  const lines = [];
  const financialDir = path.resolve(__dirname, "../financial");
  const year = new Date().getFullYear().toString();

  // 재무재표 CSV
  const csvPath = path.join(financialDir, `${year}.csv`);
  if (fs.existsSync(csvPath)) {
    const csvData = fs.readFileSync(csvPath, "utf-8");
    lines.push(`\n[재무재표 - ${year}년]`);
    lines.push(csvData);
  }

  // 지출 상세 내역
  const detailPath = path.join(financialDir, "expense_detail.json");
  if (fs.existsSync(detailPath)) {
    try {
      const detail = JSON.parse(fs.readFileSync(detailPath, "utf-8"));
      // 현재 연도 데이터만 추출
      const yearData = detail[year];
      if (yearData) {
        lines.push(`\n[지출 상세 - ${year}년]`);
        lines.push(JSON.stringify(yearData, null, 0));
      }
    } catch {}
  }

  return lines.join("\n");
}

async function handleTextMessage(botToken, message) {
  const chatId = message.chat.id;
  const messageText = String(message?.text || message?.caption || "").trim();
  const maxImageCount = parsePositiveInt(process.env.TELEGRAM_MAX_IMAGE_COUNT, DEFAULT_MAX_IMAGE_COUNT);
  const imageInputs = buildImageInputs(message, maxImageCount);

  if (!messageText && imageInputs.length === 0) return;

  // 이미지가 있으면 텍스트로 안내
  let imageNote = "";
  if (imageInputs.length > 0) {
    imageNote = "\n(이미지가 첨부되었으나 텍스트 모드에서는 분석할 수 없습니다)";
  }

  // 가계부 데이터 로드
  const sheetContext = loadCsvContext();

  const userPrompt = [
    `User: ${getSenderName(message)}`,
    messageText ? `Message: ${messageText}` : "Message: (no text)",
    sheetContext ? `\n--- 가계부 데이터 ---${sheetContext}` : ""
  ].filter(Boolean).join("\n");

  // 히스토리 로드 & 현재 메시지 추가
  const history = loadHistory(chatId);
  addToHistory(chatId, "user", messageText || "(이미지)");

  // 히스토리를 프롬프트에 포함
  let fullPrompt = "";
  if (history.length > 0) {
    fullPrompt += "이전 대화:\n";
    for (const h of history) {
      fullPrompt += h.role === "user" ? `사용자: ${h.text}\n` : `어시스턴트: ${h.text}\n`;
    }
    fullPrompt += "\n";
  }
  fullPrompt += userPrompt + imageNote;

  const answer = callClaude(SYSTEM_PROMPT, fullPrompt);
  addToHistory(chatId, "model", answer);

  await sendTelegramReply(botToken, chatId, answer || "응답을 생성할 수 없습니다.", message.message_id);
}

// --- 메시지 핸들러 ---

async function handleMessage(botToken, message) {
  const chatId = message?.chat?.id;
  if (typeof chatId !== "number") return;
  if (message?.from?.is_bot) return;

  const allowedChatIds = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? process.env.TELEGRAM_ALLOWED_CHAT_ID);
  if (allowedChatIds.size > 0 && !allowedChatIds.has(String(chatId))) return;

  try {
    await telegramApiRequest(botToken, "sendChatAction", { chat_id: chatId, action: "typing" });

    if (isXlsxDocument(message?.document)) {
      await handleXlsxUpload(botToken, message);
    } else {
      await handleTextMessage(botToken, message);
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

// --- Express API server ---

const app = express();
app.use(express.json());

// CORS for GitHub Pages
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const REPORT_PROMPT = `너는 가계부 데이터를 분석하는 금융 어드바이저야. 아래 CSV 데이터를 분석해서 월간 AI 브리핑 리포트를 작성해줘.

## 작성 규칙
1. HTML 인라인 태그를 사용해서 포맷팅해줘 (순수 텍스트가 아닌 HTML span 태그 사용)
2. 증가/긍정적인 수치: <span class="up-color">내용</span>
3. 감소/부정적인 수치: <span class="down-color">내용</span>
4. 경고/주의: <span class="warn">내용</span>
5. 강조/하이라이트: <span class="highlight">내용</span>
6. 전월 대비 소득, 저축, 지출 변화를 분석하고 원인을 파악해줘
7. 주요 항목별 증감을 구체적 금액과 퍼센트로 표시해줘
8. 마지막에 다음 달 주의사항이나 제안을 포함해줘
9. 줄바꿈은 <br> 태그를 사용해줘
10. 은퇴 플랜 코칭은 포함하지 마 (별도로 생성됨)
11. 응답은 HTML summary 본문만 반환해. JSON이나 마크다운 코드블록으로 감싸지 마
12. 한국어로 작성해`;

app.post("/api/report/generate", async (req, res) => {
  try {
    const { year, month } = req.body;
    if (!year || !month) {
      return res.status(400).json({ error: "year and month required" });
    }

    const mn = String(month).padStart(2, "0");
    const prevMn = String(parseInt(month) - 1).padStart(2, "0");
    const prevYear = parseInt(month) === 1 ? String(parseInt(year) - 1) : year;
    const prevMonth = parseInt(month) === 1 ? "12" : prevMn;

    // Read CSV data
    const financialDir = path.resolve(__dirname, "../financial");
    const csvPath = path.join(financialDir, `${year}.csv`);

    if (!fs.existsSync(csvPath)) {
      return res.status(404).json({ error: `${year}.csv not found` });
    }

    let csvData = fs.readFileSync(csvPath, "utf-8");

    // 전년도 CSV도 읽기 (1월인 경우 전년도 12월 비교 필요)
    if (parseInt(month) === 1) {
      const prevCsvPath = path.join(financialDir, `${prevYear}.csv`);
      if (fs.existsSync(prevCsvPath)) {
        const prevCsvData = fs.readFileSync(prevCsvPath, "utf-8");
        csvData = `=== ${prevYear}년 데이터 ===\n${prevCsvData}\n\n=== ${year}년 데이터 ===\n${csvData}`;
      }
    }

    const userPrompt = `아래는 ${year}년 가계부 CSV 데이터입니다. ${prevYear}년 ${prevMonth}월과 ${year}년 ${mn}월을 비교 분석한 월간 브리핑을 작성해줘.\n\n${csvData}`;

    const fullPrompt = `${REPORT_PROMPT}\n\n${userPrompt}`;

    console.log(`[Report] Generating AI report for ${year}-${mn} via Claude CLI...`);
    let report;
    try {
      report = execFileSync("claude", ["-p", "--model", "sonnet", "--bare"], {
        input: fullPrompt,
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf-8",
        timeout: 120000,
        maxBuffer: 1024 * 1024
      }).trim();
    } catch (cliErr) {
      console.error("[Report] Claude CLI failed:", cliErr.message);
      return res.status(500).json({ error: "Claude CLI failed: " + cliErr.message });
    }

    if (!report) {
      return res.status(500).json({ error: "Claude CLI returned empty response" });
    }

    // Clean up response (remove markdown code blocks if present)
    let cleanReport = report.trim();
    if (cleanReport.startsWith("```html")) cleanReport = cleanReport.slice(7);
    else if (cleanReport.startsWith("```")) cleanReport = cleanReport.slice(3);
    if (cleanReport.endsWith("```")) cleanReport = cleanReport.slice(0, -3);
    cleanReport = cleanReport.trim();

    // Determine trend
    const hasUp = cleanReport.includes("up-color") || cleanReport.includes("증가");
    const hasDown = cleanReport.includes("down-color") || cleanReport.includes("감소");
    const trend = hasUp && !hasDown ? "up" : hasDown && !hasUp ? "down" : "neutral";

    // Update summary.json
    const summaryPath = path.join(financialDir, "summary.json");
    let summaries = {};
    if (fs.existsSync(summaryPath)) {
      summaries = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
    }

    if (!summaries[year]) summaries[year] = {};
    summaries[year][mn] = {
      date: new Date().toISOString().split("T")[0],
      period: `${prevMonth}월 → ${mn}월`,
      trend,
      summary: cleanReport
    };

    fs.writeFileSync(summaryPath, JSON.stringify(summaries, null, 2), "utf-8");
    console.log(`[Report] summary.json updated for ${year}-${mn}`);

    // Git commit & push
    try {
      execSync(`git add summary.json && git commit -m "${year}년 ${parseInt(mn)}월 AI 브리핑 리포트 생성" && git push`, {
        cwd: financialDir,
        stdio: "pipe",
        timeout: 30000
      });
      console.log(`[Report] Git push completed for ${year}-${mn}`);
    } catch (gitErr) {
      console.error("[Report] Git push failed:", gitErr.message);
      // Still return success - the file was updated locally
    }

    res.json({
      success: true,
      year,
      month: mn,
      summary: summaries[year][mn]
    });

  } catch (err) {
    console.error("[Report] Error generating report:", err);
    res.status(500).json({ error: err.message });
  }
});

const API_PORT = parseInt(process.env.PORT || "3200", 10);
app.listen(API_PORT, () => {
  console.log(`API server listening on port ${API_PORT}`);
});

// --- Long polling ---

async function poll() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!botToken) {
    console.error("TELEGRAM_BOT_TOKEN missing in .env");
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
            handleMessage(botToken, message).catch((err) =>
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
