const fs = require('fs');
const path = require('path');
const https = require('https');
const url = require('url');
const { execFileSync } = require('child_process');

const ENV_PATH = path.join(__dirname, '../infinite-buy/.env');
const STATE_PATH = path.join(__dirname, '../financial/vr-state.json');

const REMINDER_HOUR = 7;
const REMINDER_MINUTE = 0;

function pad(n) { return String(n).padStart(2, '0'); }

function reminderExists(name) {
  const escName = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Reminders"
\tset theList to default list
\tset existingNames to name of every reminder of theList whose completed is false
\treturn existingNames contains "${escName}"
end tell`;
  try {
    const result = execFileSync('osascript', ['-e', script], { encoding: 'utf-8' }).trim();
    return result === 'true';
  } catch (e) {
    console.error(`reminderExists 실패: ${e.message}`);
    return false;
  }
}

function addReminder(name, body, year, month, day, hour, minute) {
  const escName = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escBody = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const script = `tell application "Reminders"
\tset d to current date
\tset year of d to ${year}
\tset month of d to ${month}
\tset day of d to ${day}
\tset hours of d to ${hour}
\tset minutes of d to ${minute}
\tset seconds of d to 0
\tmake new reminder with properties {name:"${escName}", body:"${escBody}", due date:d}
end tell`;
  try {
    execFileSync('osascript', ['-e', script], { encoding: 'utf-8' });
    console.log(`✅ 미리알림 등록: ${name} (${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)})`);
  } catch (e) {
    console.error(`미리알림 등록 실패 (${name}): ${e.message}`);
  }
}

function nextCycleDateFromStart(startStr, todayStr) {
  // KST 기준 날짜 산술 (UTC 자정 기준으로 일수 계산)
  const startUtc = Date.UTC(
    Number(startStr.slice(0, 4)),
    Number(startStr.slice(5, 7)) - 1,
    Number(startStr.slice(8, 10))
  );
  const todayUtc = Date.UTC(
    Number(todayStr.slice(0, 4)),
    Number(todayStr.slice(5, 7)) - 1,
    Number(todayStr.slice(8, 10))
  );
  const diffDays = Math.round((todayUtc - startUtc) / (24 * 3600 * 1000));
  // 다음 사이클 = 지나간 사이클 수 + 1 (오늘이 사이클 시작일이면 당일 아닌 그 다음 사이클)
  const cyclesPassed = Math.max(0, Math.floor(diffDays / 14));
  const nextN = (cyclesPassed + 1) * 14;
  const nextUtc = startUtc + nextN * 24 * 3600 * 1000;
  const dt = new Date(nextUtc);
  return {
    diffDays,
    nextDayN: nextN,
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

function loadEnv(filePath) {
  const env = {};
  fs.readFileSync(filePath, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  });
  return env;
}

function sendTelegram(token, chatId, text) {
  return new Promise((resolve, reject) => {
    const params = new url.URLSearchParams({ chat_id: chatId, text });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const r = JSON.parse(data);
        if (r.ok) { console.log(`✅ 발송 완료 (message_id: ${r.result.message_id})`); resolve(); }
        else reject(new Error(r.description));
      });
    });
    req.on('error', reject);
    req.write(params.toString());
    req.end();
  });
}

async function main() {
  const now = new Date(Date.now() + 9 * 3600 * 1000); // KST
  const todayStr = now.toISOString().slice(0, 10);
  console.log(`[${new Date().toISOString()}] VR 리마인더 실행 (KST: ${todayStr})`);

  const env = loadEnv(ENV_PATH);
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.error('❌ 텔레그램 설정 없음'); process.exit(1); }

  const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  const states = typeof data.ticker === 'string' ? { [data.ticker]: data } : data;

  for (const [ticker, state] of Object.entries(states)) {
    const startStr = state.cycleStartDate;
    if (!startStr) { console.log(`[${ticker}] cycleStartDate 없음, 건너뜀`); continue; }

    const start = new Date(startStr.slice(0, 10) + 'T00:00:00+09:00');
    const today = new Date(todayStr + 'T00:00:00+09:00');
    const diffDays = Math.round((today - start) / (1000 * 3600 * 24));

    console.log(`[${ticker}] start=${startStr.slice(0,10)}, diff=${diffDays}일, 나머지=${diffDays % 14}`);

    if (diffDays >= 0 && diffDays % 14 === 0) {
      const weekNum = Math.floor(diffDays / 14) + 1;
      const text = `⚖️ ${ticker} VR 리밸런싱 알림 (${todayStr})\n\n사이클 시작 ${diffDays}일차 (${weekNum}번째 2주 도래)\n새 V값을 계산하고 주문을 업데이트하세요!\n\n확인할 항목:\n• 현재가, 보유수량, Pool 최신값으로 업데이트\n• 새 V값 및 밴드 범위 확인\n• 매수/매도 주문 가격 업데이트 후 ☁️ 저장`;
      await sendTelegram(token, chatId, text);
    } else {
      console.log(`[${ticker}] → 텔레그램 알림 불필요`);
    }

    // 다음 사이클 시작일 미리알림 등록 (오늘이 사이클일이면 그 다음 사이클, 즉 +14일)
    const next = nextCycleDateFromStart(startStr.slice(0, 10), todayStr);
    const dateStr = `${next.year}-${pad(next.month)}-${pad(next.day)}`;
    const name = `VR 리밸런싱 — ${ticker} (${dateStr})`;
    const body = `VR 새 V값 계산 및 주문 업데이트 필요\n\n확인할 항목:\n• 현재가, 보유수량, Pool 최신값으로 업데이트\n• 새 V값 및 밴드 범위 확인\n• 매수/매도 주문 가격 업데이트 후 저장\n\n사이클 시작: ${startStr.slice(0,10)} → ${next.nextDayN}일차`;
    if (reminderExists(name)) {
      console.log(`[${ticker}] 미리알림 이미 존재: ${name}`);
    } else {
      addReminder(name, body, next.year, next.month, next.day, REMINDER_HOUR, REMINDER_MINUTE);
    }
  }
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
