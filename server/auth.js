/**
 * 최초 1회 실행: Google OAuth2 인증 후 토큰을 token.json에 저장
 * 사용법: node auth.js
 */
require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });
const fs = require("fs");
const path = require("path");
const http = require("http");
const { google } = require("googleapis");

const CREDENTIALS_PATH = path.resolve(__dirname, "credentials.json");
const TOKEN_PATH = path.resolve(__dirname, "token.json");
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const REDIRECT_PORT = 3210;

async function main() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret } = credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    `http://localhost:${REDIRECT_PORT}`
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent"
  });

  console.log("\n아래 URL을 브라우저에서 열어 Google 로그인하세요:\n");
  console.log(authUrl);
  console.log("\n로그인 후 자동으로 토큰이 저장됩니다...\n");

  const code = await waitForAuthCode();
  const { tokens } = await oAuth2Client.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log("토큰이 저장되었습니다:", TOKEN_PATH);
}

function waitForAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get("code");
      if (code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h2>인증 완료! 이 창을 닫아도 됩니다.</h2>");
        server.close();
        resolve(code);
      } else {
        res.writeHead(400);
        res.end("No code found");
      }
    });
    server.listen(REDIRECT_PORT, () => {
      console.log(`콜백 서버 대기 중: http://localhost:${REDIRECT_PORT}`);
    });
    server.on("error", reject);
  });
}

main().catch(console.error);
