const fs = require('fs');
const path = require('path');
const https = require('https');
const url = require('url');

const ENV_PATH = path.join(__dirname, '../infinite-buy/.env');
const STATE_PATH = path.join(__dirname, '../financial/vr-state.json');

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
      console.log(`[${ticker}] → 알림 불필요`);
    }
  }
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
