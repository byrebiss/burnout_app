const express = require('express');
const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const APP_URL = 'https://byrebiss.github.io/burnout_app';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// Telegram API helper
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // отвечаем Telegram сразу

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

Это приложение помогает отслеживать твоё эмоциональное и физическое состояние — раз в день или раз в неделю.

<b>Как работает:</b>
• 18 вопросов по 6 категориям: энергия, сон, тело, эмоции, работа, смысл
• Видишь динамику и тренды во времени
• Только ты видишь свои данные

После 3 чекинов появятся первые инсайты 📊`,
      reply_markup: {
        inline_keyboard: [[
          {
            text: '🚀 Открыть детектор',
            web_app: { url: APP_URL }
          }
        ]]
      }
    });
  }
});

// Health check
app.get('/', (req, res) => res.send('Burnout Detector Bot is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));
