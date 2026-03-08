#!/usr/bin/env node
// Запусти этот скрипт ОДИН РАЗ после деплоя на Railway
// node setup-webhook.js

const TOKEN = process.env.BOT_TOKEN;
const RAILWAY_URL = process.env.RAILWAY_URL; // например: https://burnout-bot.up.railway.app

if (!TOKEN || !RAILWAY_URL) {
  console.error('❌ Нужны переменные: BOT_TOKEN и RAILWAY_URL');
  console.error('Пример: BOT_TOKEN=123:ABC RAILWAY_URL=https://yourapp.up.railway.app node setup-webhook.js');
  process.exit(1);
}

async function setup() {
  const webhookUrl = `${RAILWAY_URL}/webhook`;
  
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl })
  });
  
  const data = await res.json();
  
  if (data.ok) {
    console.log(`✅ Webhook установлен: ${webhookUrl}`);
  } else {
    console.error('❌ Ошибка:', data.description);
  }
}

setup();
