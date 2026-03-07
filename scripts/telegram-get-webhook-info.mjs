const botToken = requireEnv("TELEGRAM_BOT_TOKEN");

const response = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
  method: "GET"
});

if (!response.ok) {
  const errorText = await response.text();
  console.error(`getWebhookInfo failed (${response.status}): ${errorText}`);
  process.exit(1);
}

const result = await response.json();
console.log(JSON.stringify(result, null, 2));

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return value;
}
