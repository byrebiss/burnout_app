const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_TG_ID = process.env.ADMIN_TG_ID; // твой Telegram ID для /stats
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

// ── Supabase helper ──
async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...(options.headers || {}),
    },
  });
  if (options.method === 'POST' && options.prefer === 'minimal') return { ok: res.ok };
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

  try { return JSON.parse(userParam); } catch { return null; }
}

// ── CORS ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://byrebiss.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Авторизация через Telegram ──
app.post('/auth/telegram', async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.status(400).json({ error: 'No initData' });

  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });

  // Логируем открытие приложения
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/app_opens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ tg_id: user.id }),
    });
  } catch (e) { console.warn('app_opens log failed:', e); }

  return res.json({
    ok: true,
    user: {
      tg_id: user.id,
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      username: user.username || null,
    }
  });
});

// ── Сохранение чекина ──
app.post('/checkin', async (req, res) => {
  const { initData, checkin } = req.body;
  if (!initData || !checkin) return res.status(400).json({ error: 'Missing data' });

  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });

  const response = await fetch(`${SUPABASE_URL}/rest/v1/checkins`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      tg_id: user.id,
      date: checkin.date,
      answers: checkin.answers,
      note: checkin.note || null,
      score: checkin.score || null,
    }),
  });

  if (!response.ok) return res.status(500).json({ error: 'DB error' });
  return res.json({ ok: true });
});

// ── Получение чекинов ──
app.post('/checkins/get', async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });

  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });

  const data = await sb(`checkins?tg_id=eq.${user.id}&order=date.asc`);
  return res.json({ ok: true, checkins: data });
});

// ── Сохранение напоминания ──
app.post('/reminder/set', async (req, res) => {
  const { initData, hour, minute, enabled } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });

  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });

  await fetch(`${SUPABASE_URL}/rest/v1/reminders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      tg_id: user.id,
      hour: hour ?? 20,
      minute: minute ?? 0,
      enabled: enabled !== false,
      updated_at: new Date().toISOString(),
    }),
  });

  return res.json({ ok: true });
});

// ── Отправка напоминаний (вызывается GitHub Actions каждый час) ──
app.post('/reminders/send', async (req, res) => {
  // Простая защита — секретный ключ
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();

  // Берём всех у кого сейчас время напоминания (±5 минут)
  const reminders = await sb(`reminders?enabled=eq.true&hour=eq.${currentHour}`);

  if (!Array.isArray(reminders) || !reminders.length) {
    return res.json({ ok: true, sent: 0 });
  }

  let sent = 0;
  for (const reminder of reminders) {
    // Проверяем минуты (±3 минуты — Actions запускается каждые 5 мин)
    if (Math.abs(reminder.minute - currentMinute) > 3) continue;

    // Получаем последний чекин пользователя
    const checkins = await sb(`checkins?tg_id=eq.${reminder.tg_id}&order=date.desc&limit=1`);
    const lastCheckin = Array.isArray(checkins) ? checkins[0] : null;

    let statsText = '';
    if (lastCheckin) {
      const daysAgo = Math.floor((Date.now() - new Date(lastCheckin.date)) / 864e5);
      const score = lastCheckin.score;
      if (daysAgo === 0) continue; // уже делал чекин сегодня — не беспокоим
      statsText = daysAgo === 1
        ? `\n\n📊 Последний чекин: вчера, индекс <b>${score}/10</b>`
        : `\n\n📊 Последний чекин: ${daysAgo} дн. назад, индекс <b>${score}/10</b>`;
    }

    await tg('sendMessage', {
      chat_id: reminder.tg_id,
      parse_mode: 'HTML',
      text: `🔥 Время чекина!

Как ты сейчас? Пройди короткий опрос — займёт 2 минуты.${statsText}`,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Пройти чекин', web_app: { url: APP_URL } }
        ]]
      }
    });
    sent++;
  }

  return res.json({ ok: true, sent });
});

// ── Статистика для админа ──
app.get('/admin/stats', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const weekAgo = new Date(now - 7 * 864e5).toISOString();

  const [allOpens, todayOpens, weekCheckins, allCheckins, reminders] = await Promise.all([
    sb('app_opens?select=tg_id'),
    sb(`app_opens?opened_at=gte.${today}&select=tg_id`),
    sb(`checkins?date=gte.${weekAgo}&select=tg_id`),
    sb('checkins?select=tg_id'),
    sb('reminders?enabled=eq.true&select=tg_id'),
  ]);

  const uniqueUsers = new Set(Array.isArray(allOpens) ? allOpens.map(r => r.tg_id) : []).size;
  const todayUsers = new Set(Array.isArray(todayOpens) ? todayOpens.map(r => r.tg_id) : []).size;
  const weekActive = new Set(Array.isArray(weekCheckins) ? weekCheckins.map(r => r.tg_id) : []).size;
  const totalCheckins = Array.isArray(allCheckins) ? allCheckins.length : 0;
  const remindersOn = Array.isArray(reminders) ? reminders.length : 0;

  return res.json({ uniqueUsers, todayUsers, weekActive, totalCheckins, remindersOn });
});

// ── Удаление одного чекина по дате ──
app.post('/checkin/delete', async (req, res) => {
  const { initData, date } = req.body;
  if (!initData || !date) return res.status(400).json({ error: 'Missing data' });

  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });

  const datePrefix = date.slice(0, 19); // без миллисекунд
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/checkins?tg_id=eq.${user.id}&date=like.${encodeURIComponent(datePrefix + '%')}`,
    {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
    }
  );

  if (!response.ok) return res.status(500).json({ error: 'DB error' });
  return res.json({ ok: true });
});

// ── Удаление всех чекинов пользователя ──
app.post('/checkins/delete', async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });

  const user = verifyTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });

  const response = await fetch(`${SUPABASE_URL}/rest/v1/checkins?tg_id=eq.${user.id}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
  });

  if (!response.ok) return res.status(500).json({ error: 'DB error' });
  return res.json({ ok: true });
});

// ── Webhook Telegram ──
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const { message, callback_query } = req.body;

  // ── Обработка кнопки "Написать разработчику" ──
  if (callback_query?.data === 'feedback') {
    await tg('answerCallbackQuery', { callback_query_id: callback_query.id });
    await tg('sendMessage', {
      chat_id: callback_query.from.id,
      parse_mode: 'HTML',
      text: `✉️ <b>Обратная связь</b>\n\nНапиши своё мнение, идею или замечание — следующим сообщением.\n\nВсё анонимно: я не вижу кто пишет, только текст 👇`,
    });
    return;
  }

  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text || '';
  const firstName = message.from?.first_name || 'друг';
  const userId = message.from?.id;

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

После 3 чекинов появятся первые закономерности 📊

——
<i>⚗️ Это тестовая версия. Все данные анонимны. Если есть идеи или замечания — жми кнопку ниже 🙏</i>`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Открыть детектор', web_app: { url: APP_URL } }],
          [{ text: '✉️ Написать разработчику', callback_data: 'feedback' }],
        ]
      }
    });
  }

  // ── Анонимный фидбек — пересылаем разработчику ──
  if (!text.startsWith('/') && String(userId) !== String(ADMIN_TG_ID) && ADMIN_TG_ID) {
    await tg('sendMessage', {
      chat_id: ADMIN_TG_ID,
      parse_mode: 'HTML',
      text: `💬 <b>Анонимный фидбек:</b>\n\n${text}`,
    });
    await tg('sendMessage', {
      chat_id: chatId,
      text: '✅ Спасибо! Сообщение отправлено анонимно 🙏',
    });
    return;
  }

  // Статистика только для тебя
  if (text === '/stats' && String(userId) === String(ADMIN_TG_ID)) {
    try {
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const weekAgo = new Date(now - 7 * 864e5).toISOString();

      const [allOpens, todayOpens, weekCheckins, allCheckins, reminders] = await Promise.all([
        sb('app_opens?select=tg_id'),
        sb(`app_opens?opened_at=gte.${today}&select=tg_id`),
        sb(`checkins?date=gte.${weekAgo}&select=tg_id`),
        sb('checkins?select=tg_id'),
        sb('reminders?enabled=eq.true&select=tg_id'),
      ]);

      const uniqueUsers = new Set(Array.isArray(allOpens) ? allOpens.map(r => r.tg_id) : []).size;
      const todayUsers = new Set(Array.isArray(todayOpens) ? todayOpens.map(r => r.tg_id) : []).size;
      const weekActive = new Set(Array.isArray(weekCheckins) ? weekCheckins.map(r => r.tg_id) : []).size;
      const totalCheckins = Array.isArray(allCheckins) ? allCheckins.length : 0;
      const remindersOn = Array.isArray(reminders) ? reminders.length : 0;

      await tg('sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text:
`📊 <b>Статистика Детектора выгорания</b>

👥 Всего уникальных пользователей: <b>${uniqueUsers}</b>
📅 Открыли сегодня: <b>${todayUsers}</b>
🔥 Активных за неделю: <b>${weekActive}</b>
✅ Всего чекинов: <b>${totalCheckins}</b>
🔔 Включили напоминания: <b>${remindersOn}</b>`
      });
    } catch (e) {
      await tg('sendMessage', { chat_id: chatId, text: 'Ошибка получения статистики' });
    }
  }
});

// ── Health check ──
app.get('/', (req, res) => res.send('Burnout Detector Bot is running ✓'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));
