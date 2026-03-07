const botToken = requireEnv("TELEGRAM_BOT_TOKEN");
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || "";
const projectId =
  process.env.FIREBASE_PROJECT_ID?.trim() ||
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
  "";
const functionsRegion =
  process.env.FUNCTIONS_REGION?.trim() ||
  process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION?.trim() ||
  "us-central1";
const computedWebhookUrl = projectId
  ? `https://${functionsRegion}-${projectId}.cloudfunctions.net/telegramWebhook`
  : "";
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim() || computedWebhookUrl;

if (!webhookUrl) {
  console.error(
    "Missing TELEGRAM_WEBHOOK_URL. Or set FIREBASE_PROJECT_ID/NEXT_PUBLIC_FIREBASE_PROJECT_ID so URL can be auto-generated."
  );
  process.exit(1);
}

if (!webhookUrl.startsWith("https://")) {
  console.error("TELEGRAM_WEBHOOK_URL must start with https://");
  process.exit(1);
}

const payload = {
  url: webhookUrl,
  allowed_updates: ["message", "channel_post"],
  drop_pending_updates: false
};

if (webhookSecret) {
  payload.secret_token = webhookSecret;
}

const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify(payload)
});

if (!response.ok) {
  const errorText = await response.text();
  console.error(`setWebhook failed (${response.status}): ${errorText}`);
  process.exit(1);
}

const result = await response.json();
if (!result.ok) {
  console.error("setWebhook returned error:", JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log("Webhook configured successfully.");
console.log(JSON.stringify(result, null, 2));

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return value;
}
