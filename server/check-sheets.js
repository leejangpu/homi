require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const CREDENTIALS_PATH = path.resolve(__dirname, "credentials.json");
const TOKEN_PATH = path.resolve(__dirname, "token.json");

const SHEET_IDS = [
  "1zu3ymV9140Gx9J_LMeL7qy9mXm-aeBnl1ExXH7SrQas",
  "1fI9WsgLd1oJ9h5A4L34Y7zK4pngM844sHKXeJd5qK0Y"
];

function getAuth() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, "http://localhost:3210");
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  oAuth2Client.setCredentials(tokens);
  return oAuth2Client;
}

async function main() {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  for (const id of SHEET_IDS) {
    console.log(`\n=== Spreadsheet: ${id} ===`);
    try {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
      console.log(`Title: ${meta.data.properties.title}`);
      console.log(`Sheets:`);
      for (const sheet of meta.data.sheets) {
        const title = sheet.properties.title;
        console.log(`  - ${title}`);
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: id,
          range: `'${title}'!A1:Z5`
        });
        const rows = res.data.values || [];
        for (const row of rows) {
          console.log(`    ${row.join(" | ")}`);
        }
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  }
}

main().catch(console.error);
