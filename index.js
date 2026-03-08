const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_URL = 'https://byrebiss.github.io/burnout_app';

// ── Telegram API helper ──
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Проверка подписи Telegram initData ──
function verifyTelegramData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (expectedHash !== hash) return null;

  const userParam = params.get('user');
  if (!userParam) return null;

  try {
    return JSON.parse(userParam);
  } catch {
    return null;
  }
}

// ── CORS для GitHub Pages ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://byrebiss.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Авторизация через Telegram ──
// Приложение отправляет initData, сервер проверяет и сохраняет/возвращает данные пользователя
app.post('/auth/telegram', async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.status(400).json({ error: 'No initData' });

  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });

  const tgId = user.id;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const username = user.username || null;

  // Возвращаем данные пользователя — приложение использует tg_id для сохранения
  return res.json({
    ok: true,
    user: { tg_id: tgId, name, username }
  });
});

// ── Сохранение чекина ──
app.post('/checkin', async (req, res) => {
  const { initData, checkin } = req.body;
  if (!initData || !checkin) return res.status(400).json({ error: 'Missing data' });

  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });

  const row = {
    tg_id: user.id,
    date: checkin.date,
    answers: checkin.answers,
    note: checkin.note || null,
    score: checkin.score || null,
  };

  const response = await fetch(`${SUPABASE_URL}/rest/v1/checkins`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Supabase error:', err);
    return res.status(500).json({ error: 'DB error' });
  }

  return res.json({ ok: true });
});

// ── Получение чекинов пользователя ──
app.post('/checkins/get', async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });

  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/checkins?tg_id=eq.${user.id}&order=date.asc`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  const data = await response.json();
  return res.json({ ok: true, checkins: data });
});

// ── Webhook Telegram ──
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const { message } = req.body;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text || '';
  const firstName = message.from?.first_name || 'друг';

  if (text === '/start') {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
`🔥 <b>Детектор выгорания</b>

Привет, ${firstName}!

Отслеживай своё состояние раз в день или раз в неделю — и увидишь когда начинается выгорание.

<b>Что внутри:</b>
• 18 вопросов: энергия, сон, тело, эмоции, работа, смысл
• График динамики и инсайты
• Данные привязаны к твоему Telegram — доступны с любого устройства

После 3 чекинов появятся первые закономерности 📊`,
      reply_markup: {
        inline_keyboard: [[
          { text: '🚀 Открыть детектор', web_app: { url: APP_URL } }
        ]]
      }
    });
  }
});

// ── Health check ──
app.get('/', (req, res) => res.send('Burnout Detector Bot is running ✓'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));
