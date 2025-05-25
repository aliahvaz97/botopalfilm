require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const Admin = require('./models/Admin');
const Video = require('./models/Video');

const app = express();
app.use(bodyParser.json());

const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });
const WEBHOOK_URL = `${process.env.BASE_URL}/bot${process.env.BOT_TOKEN}`;
bot.setWebHook(WEBHOOK_URL);

const OWNER_ID = parseInt(process.env.OWNER_ID);
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME.startsWith('@') ? process.env.CHANNEL_USERNAME : '@' + process.env.CHANNEL_USERNAME;

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

async function isUserSubscribed(userId) {
  try {
    const res = await bot.getChatMember(CHANNEL_USERNAME, userId);
    return ['member', 'administrator', 'creator'].includes(res.status);
  } catch (e) {
    console.error(`❌ Error checking subscription for user ${userId}:`, e.response?.body || e.message);
    return false;
  }
}

async function isAdmin(user) {
  if (user.id === OWNER_ID) return true;
  const username = user.username;
  const admin = await Admin.findOne({
    $or: [
      { userId: user.id },
      ...(username ? [{ username }] : [])
    ]
  });
  return !!admin;
}

async function sendVideoList(chatId, page = 0, messageId = null) {
  const limit = 5;
  const skip = page * limit;
  const total = await Video.countDocuments();
  const videos = await Video.find().sort({ createdAt: -1 }).skip(skip).limit(limit);

  if (!videos.length) return bot.sendMessage(chatId, "فیلمی موجود نیست.");

  const buttons = videos.map(v => [{ text: v.title, callback_data: `video_${v._id}` }]);
  const nav = [];
  if (page > 0) nav.push({ text: "⬅️ قبل", callback_data: `page_${page - 1}` });
  if ((page + 1) * limit < total) nav.push({ text: "➡️ بعد", callback_data: `page_${page + 1}` });
  if (nav.length) buttons.push(nav);

  const opts = { reply_markup: { inline_keyboard: buttons } };

  if (messageId) {
    bot.editMessageText("🎬 لیست فیلم‌ها:", { chat_id: chatId, message_id: messageId, ...opts });
  } else {
    bot.sendMessage(chatId, "🎬 لیست فیلم‌ها:", opts);
  }
}

const state = new Map();

bot.onText(/\/start(?:\s+(video_\w+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const subscribed = await isUserSubscribed(userId);
  if (!subscribed) {
    const opts = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 عضویت در کانال", url: `https://t.me/${CHANNEL_USERNAME.replace('@', '')}` }],
          [{ text: "✅ بررسی عضویت", callback_data: "check_membership" }]
        ]
      }
    };
    return bot.sendMessage(chatId, "برای دریافت فیلم، ابتدا عضو کانال شوید:", opts);
  }

  if (match && match[1]) {
    const videoId = match[1].split('_')[1];
    const video = await Video.findById(videoId);
    if (video) return bot.sendVideo(chatId, video.fileId, { caption: video.title });
    return bot.sendMessage(chatId, "❌ فیلم پیدا نشد.");
  }

  sendVideoList(chatId, 0);
});

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const chatId = query.message.chat.id;

  if (query.data === 'check_membership') {
    const isMember = await isUserSubscribed(userId);
    if (isMember) {
      bot.editMessageText("✅ شما عضو کانال هستید.", {
        chat_id: chatId,
        message_id: query.message.message_id
      });
      sendVideoList(chatId, 0);
    } else {
      bot.answerCallbackQuery(query.id, { text: "❌ هنوز عضو نیستی!" });
    }
  }

  if (query.data.startsWith('page_')) {
    const page = parseInt(query.data.split('_')[1]);
    sendVideoList(chatId, page, query.message.message_id);
  }

  if (query.data.startsWith('video_')) {
    const id = query.data.split('_')[1];
    const video = await Video.findById(id);
    if (video) bot.sendVideo(chatId, video.fileId, { caption: video.title });
  }
});

bot.onText(/\/addadmin (\d+)/, async (msg, match) => {
  if (msg.from.id !== OWNER_ID) return;
  const userId = parseInt(match[1]);
  await Admin.updateOne({ userId }, {}, { upsert: true });
  bot.sendMessage(msg.chat.id, `✅ کاربر ${userId} به عنوان ادمین اضافه شد.`);
});

bot.onText(/\/addadmin(?:\s+@?(\w+))/, async (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (senderId !== OWNER_ID) return bot.sendMessage(chatId, "⛔ فقط مالک بات می‌تواند ادمین اضافه کند.");

  const username = match[1];
  if (!username) return;

  const existing = await Admin.findOne({ username });
  if (existing) return bot.sendMessage(chatId, `⚠️ کاربر @${username} قبلاً ادمین شده.`);

  await new Admin({ username }).save();
  bot.sendMessage(chatId, `✅ کاربر @${username} به عنوان ادمین اضافه شد.`);
});

bot.onText(/\/admin/, async (msg) => {
  if (!await isAdmin(msg.from)) return bot.sendMessage(msg.chat.id, "❌ دسترسی نداری.");

  const keyboard = {
    reply_markup: {
      keyboard: [
        ['➕ افزودن فیلم', '🎬 لیست فیلم‌ها'],
        ['👤 افزودن ادمین جدید']
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
  bot.sendMessage(msg.chat.id, "🎛 به پنل مدیریت خوش آمدی:", keyboard);
});

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const isUserAdmin = await isAdmin(msg.from);
  if (!isUserAdmin) return;

  const currentState = state.get(userId);

  if (msg.text === '➕ افزودن فیلم') {
    bot.sendMessage(msg.chat.id, "📝 لطفاً عنوان فیلم را وارد کن:");
    state.set(userId, { step: 'awaiting_title' });
    return;
  }

  if (currentState?.step === 'awaiting_title') {
    state.set(userId, { step: 'awaiting_video', data: { title: msg.text } });
    bot.sendMessage(msg.chat.id, "📥 حالا فایل ویدیوی فیلم را ارسال کن:");
    return;
  }

  if (currentState?.step === 'awaiting_video' && msg.video) {
    const { title } = currentState.data;
    const fileId = msg.video.file_id;
    const savedVideo = await new Video({ title, fileId }).save();
    const videoLink = `https://t.me/${process.env.BOT_USERNAME}?start=video_${savedVideo._id}`;
    bot.sendMessage(msg.chat.id, `✅ فیلم ذخیره شد.

🔗 لینک مستقیم:
${videoLink}`);
    state.delete(userId);
    return;
  }

  if (msg.text === '👤 افزودن ادمین جدید') {
    bot.sendMessage(msg.chat.id, "👤 لطفاً آیدی عددی یا یوزرنیم ادمین جدید را وارد کن:");
    state.set(userId, { step: 'awaiting_new_admin' });
    return;
  }

  if (currentState?.step === 'awaiting_new_admin') {
    const input = msg.text.trim();
    state.delete(userId);

    if (/^\d+$/.test(input)) {
      const newAdminId = parseInt(input);
      await Admin.updateOne({ userId: newAdminId }, {}, { upsert: true });
      return bot.sendMessage(msg.chat.id, `✅ ادمین با آیدی ${newAdminId} اضافه شد.`);
    }

    const username = input.replace('@', '');
    if (/^[a-zA-Z0-9_]{5,}$/.test(username)) {
      await Admin.updateOne({ username }, {}, { upsert: true });
      return bot.sendMessage(msg.chat.id, `✅ ادمین با یوزرنیم @${username} اضافه شد.`);
    }

    return bot.sendMessage(msg.chat.id, "❌ ورودی نامعتبر بود. فقط عدد یا یوزرنیم مجاز است.");
  }

  if (msg.text === '🎬 لیست فیلم‌ها') {
    const videos = await Video.find().sort({ createdAt: -1 }).limit(10);
    const list = videos.map(v => `• ${v.title}`).join('\n') || 'هیچ فیلمی موجود نیست.';
    bot.sendMessage(msg.chat.id, `🎬 لیست فیلم‌ها:

${list}`);
  }
});

bot.on('video', async (msg) => {
  const user = msg.from;
  if (!await isAdmin(user)) return bot.sendMessage(msg.chat.id, "⛔ فقط ادمین می‌تونه فیلم ارسال کنه.");

  const caption = msg.caption || "بدون عنوان";
  const fileId = msg.video.file_id;
  const savedVideo = await new Video({ title: caption, fileId }).save();
  const videoLink = `https://t.me/${process.env.BOT_USERNAME}?start=video_${savedVideo._id}`;

  bot.sendMessage(msg.chat.id, `✅ فیلم ذخیره شد.

🔗 لینک مستقیم:
${videoLink}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
