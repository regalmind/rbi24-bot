// ========================================
// RBI24 Telegram Bot - Educational System
// Version 2.0 - Updated & Refactored
// ========================================

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json());

// ---- Configuration from environment variables ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";
const ADMIN_SYNC_SECRET = process.env.ADMIN_SYNC_SECRET || "change_me_in_production";
const PORT = process.env.PORT || 8080;

// Channel Links (can be updated via ENV or here)
const CHANNELS = {
  starter: process.env.STARTER_CHANNEL || "@RBI24_Starter",
  supporter: process.env.SUPPORTER_CHANNEL || "@RBI24_Supporter",
  doer: process.env.DOER_CHANNEL || "@RBI24_Doer",
  advisor: process.env.ADVISOR_CHANNEL || "@RBI24_Advisor"
};

if (!BOT_TOKEN || !SPREADSHEET_ID) {
  console.error("❌ BOT_TOKEN and SPREADSHEET_ID must be set as environment variables");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ---- Google Sheets auth using service account ----
let sheetsClient;

async function initSheetsClient() {
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  let auth;
  
  if (rawKey) {
    const key = JSON.parse(rawKey);
    auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  } else {
    auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }
  
  sheetsClient = google.sheets({ version: 'v4', auth });
  console.log("✅ Google Sheets client initialized");
}

// ---- Ensure Sheet Structure ----
async function ensureSheetHeaders() {
  const sheets = sheetsClient;
  const meta = [
    { 
      name: "Users", 
      headers: ["UserID", "Username", "FirstName", "LastName", "Email", "EmailConfirmed", "JoinedAt", "LastActive"] 
    },
    { 
      name: "State", 
      headers: ["UserID", "Step", "TempData", "LastMenu", "TempEmail"] 
    },
    { 
      name: "Tickets", 
      headers: ["TicketID", "UserID", "Email", "Message", "Answer", "CreatedAt", "AnsweredAt", "Notified"] 
    },
    { 
      name: "EmailLog", 
      headers: ["UserID", "Email", "Count", "LastSentAt"] 
    },
    { 
      name: "InvestRequests", 
      headers: ["RequestID", "UserID", "FullName", "Email", "TxHash", "Duration", "Amount", "Status", "Notified", "CreatedAt"] 
    },
    { 
      name: "WithdrawRequests", 
      headers: ["RequestID", "UserID", "FullName", "Email", "WalletAddress", "Amount", "Status", "Notified", "CreatedAt"] 
    },
    { 
      name: "BroadcastLogs", 
      headers: ["BroadcastID", "UserID", "MessageID", "SentAt", "DeletedFlag"] 
    },
    { 
      name: "Announcements", 
      headers: ["ID", "Title", "Message", "CreatedAt", "IsActive"] 
    },
    { 
      name: "FAQ", 
      headers: ["ID", "Category", "Question", "Answer", "Order"] 
    },
    {
      name: "UserActions",
      headers: ["UserID", "Action", "Timestamp"]
    },
    {
      name: "TicketRateLimits",
      headers: ["UserID", "Count", "LastTicketAt"]
    },
    {
      name: "Lessons",
      headers: ["ID", "Key", "Title", "TextContent", "VideoLink", "IsActive"]
    },
    {
      name: "FilteredBroadcast",
      headers: ["BroadcastID", "TargetUserIDs", "Message", "SentAt", "SentCount"]
    }
  ];

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = spreadsheet.data.sheets.map(s => s.properties.title);

  for (const s of meta) {
    if (!existing.includes(s.name)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: s.name } } }]
        }
      });
      
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${s.name}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [s.headers] }
      });
      
      console.log(`✅ Created sheet: ${s.name}`);
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${s.name}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [s.headers] }
      });
    }
  }
  
  console.log("✅ All sheets verified");
}

// ========================================
// GOOGLE SHEETS HELPERS
// ========================================

async function appendRow(sheetName, rowValues) {
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:A`,
    valueInputOption: "RAW",
    requestBody: { values: [rowValues] }
  });
}

async function readSheet(sheetName) {
  try {
    const res = await sheetsClient.spreadsheets.values.get({ 
      spreadsheetId: SPREADSHEET_ID, 
      range: `${sheetName}` 
    });
    return res.data.values || [];
  } catch (e) {
    console.error(`Error reading sheet ${sheetName}:`, e.message);
    return [];
  }
}

function findIndexByFirstCol(data, val) {
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(val)) return i;
  }
  return -1;
}

async function updateRow(sheetName, rowNumber, rowValues) {
  const range = `${sheetName}!A${rowNumber}:Z${rowNumber}`;
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [rowValues] }
  });
}

// ========================================
// TELEGRAM HELPERS
// ========================================

async function telegramCall(method, payload) {
  try {
    const res = await axios.post(`${TELEGRAM_API}/${method}`, payload, { timeout: 15000 });
    return res.data;
  } catch (err) {
    console.error('❌ telegramCall error:', err?.response?.data || err.message);
    
    try { 
      await sendMessage(ADMIN_CHAT_ID, `⚠️ API Error: ${JSON.stringify(err?.response?.data || err.message)}`); 
    } catch(e) {}
    
    return null;
  }
}

async function sendMessage(chatId, text, reply_markup) {
  const payload = {
    chat_id: String(chatId),
    text,
    parse_mode: 'HTML'
  };
  
  if (reply_markup) payload.reply_markup = reply_markup;
  
  const r = await telegramCall('sendMessage', payload);
  return r && r.ok ? r.result.message_id : null;
}

async function editMessageText(chatId, messageId, text, reply_markup) {
  return telegramCall('editMessageText', { 
    chat_id: String(chatId), 
    message_id: Number(messageId), 
    text, 
    parse_mode: 'HTML', 
    reply_markup 
  });
}

async function answerCallbackQuery(callbackQueryId, text) {
  return telegramCall('answerCallbackQuery', { 
    callback_query_id: callbackQueryId, 
    text 
  });
}

async function deleteMessage(chatId, messageId) {
  try {
    await telegramCall('deleteMessage', { 
      chat_id: String(chatId), 
      message_id: Number(messageId) 
    });
  } catch (e) {
    // Ignore if already deleted
  }
}

// ========================================
// FORMATTING & KEYBOARDS
// ========================================

function formatMessage(title, content, footer) {
  let msg = `🌟 <b>${title}</b> 🌟\n━━━━━━━━━━━━━━━\n${content}`;
  if (footer) msg += `\n━━━━━━━━━━━━━━━\n${footer}`;
  return msg;
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📖 آموزش‌های اولیه", callback_data: "edu_initial" }],
      [{ text: "❓ سوالات متداول", callback_data: "faq_menu" }],
      [{ text: "🛟 پشتیبانی", callback_data: "support_menu" }],
      [{ text: "ℹ️ درباره ما", callback_data: "about_menu" }]
    ]
  };
}

function supportMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🎫 ارسال تیکت", callback_data: "support_ticket" }],
      [{ text: "📧 پشتیبانی ایمیلی", callback_data: "support_email" }],
      [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main" }]
    ]
  };
}

function eduInitialKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "👜 نحوه نصب ولت نرم‌افزاری", callback_data: "lesson_wallet_install" }],
      [{ text: "💸 دریافت و انتقال ارز از ولت شخصی", callback_data: "lesson_wallet_transfer" }],
      [{ text: "🏦 نحوه خرید ارز از صرافی دیجیتال", callback_data: "lesson_exchange_buy" }],
      [{ text: "💰 نحوه فروش ارز به صرافی دیجیتال", callback_data: "lesson_exchange_sell" }],
      [{ text: "📋 ثبت‌نام و احراز هویت در صندوق", callback_data: "lesson_fund_register" }],
      [{ text: "📝 نحوه بستن قرارداد جدید در صندوق", callback_data: "lesson_fund_contract" }],
      [{ text: "🏧 نحوه برداشت سود و کمیسیون", callback_data: "lesson_withdraw_profit" }],
      [{ text: "🔐 فعال‌سازی کد دو عاملی گوگل", callback_data: "lesson_2fa" }],
      [{ text: "🆔 نحوه استفاده از پوزیشن آیدی", callback_data: "lesson_position_id" }],
      [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main" }]
    ]
  };
}

function faqMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🏦 درباره صندوق", callback_data: "faq_about_fund" }],
      [{ text: "📈 سود و کمیسیون", callback_data: "faq_profit" }],
      [{ text: "🔒 امنیت و قوانین", callback_data: "faq_security" }],
      [{ text: "📞 پشتیبانی", callback_data: "faq_support" }],
      [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main" }]
    ]
  };
}

function aboutMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🎯 ماموریت ما", callback_data: "about_mission" }],
      [{ text: "🏗️ ساختار سازمانی", callback_data: "about_structure" }],
      [{ text: "📜 قوانین و مقررات", callback_data: "about_rules" }],
      [{ text: "📡 کانال‌های رسمی", callback_data: "about_channels" }],
      [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main" }]
    ]
  };
}

function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📊 آمار", callback_data: "admin_stats" },
        { text: "🎫 تیکت‌های باز", callback_data: "admin_tickets" }
      ],
      [
        { text: "📢 پیام همگانی", callback_data: "admin_broadcast" },
        { text: "🎯 پیام فیلتر شده", callback_data: "admin_filtered_broadcast" }
      ],
      [
        { text: "📋 مدیریت اطلاعیه", callback_data: "admin_announcements" },
        { text: "💾 بکاپ دیتابیس", callback_data: "admin_backup" }
      ],
      [{ text: "❌ بستن پنل", callback_data: "admin_close" }]
    ]
  };
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

function getNow() {
  try {
    return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tehran' }).replace('T', ' ');
  } catch (e) {
    return new Date().toISOString();
  }
}

function isValidEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Log user action (برای آمار رفتاری - بدون اطلاعات حساس)
async function logUserAction(userId, action) {
  try {
    const timestamp = getNow();
    await appendRow("UserActions", [userId, action, timestamp]);
  } catch (e) {
    // Silent fail
  }
}

// ========================================
// USER MANAGEMENT
// ========================================

async function getUserById(userId) {
  const data = await readSheet("Users");
  const idx = findIndexByFirstCol(data, userId);
  
  if (idx === -1) return null;
  
  const row = data[idx];
  return { 
    userId: row[0], 
    username: row[1], 
    firstName: row[2], 
    lastName: row[3], 
    email: row[4],
    emailConfirmed: row[5] || "No",
    joinedAt: row[6] || "",
    lastActive: row[7] || "",
    rowIndex: idx + 1 
  };
}

async function registerOrUpdateUser(userId, firstName, lastName, username, email, emailConfirmed) {
  const data = await readSheet("Users");
  const idx = findIndexByFirstCol(data, userId);
  const now = getNow();
  
  if (idx > -1) {
    const row = data[idx];
    row[1] = username || row[1] || "";
    row[2] = firstName || row[2] || "";
    row[3] = lastName || row[3] || "";
    
    if (email) row[4] = email;
    if (emailConfirmed) row[5] = emailConfirmed;
    
    if (!row[6] || String(row[6]).trim() === "") row[6] = now;
    
    row[7] = now; // LastActive
    
    await updateRow("Users", idx + 1, row);
  } else {
    await appendRow("Users", [
      userId, 
      username || "", 
      firstName || "", 
      lastName || "", 
      email || "", 
      emailConfirmed || "No",
      now,
      now
    ]);
  }
}

async function updateUserEmail(userId, email, confirmed = "Yes") {
  const data = await readSheet("Users");
  const idx = findIndexByFirstCol(data, userId);
  
  if (idx > -1) {
    const row = data[idx];
    row[4] = email;
    row[5] = confirmed;
    await updateRow("Users", idx + 1, row);
  }
}

// ========================================
// USER STATE MANAGEMENT
// ========================================

async function setUserStateFields(userId, fields) {
  const data = await readSheet("State");
  let idx = -1;
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(userId)) { 
      idx = i; 
      break; 
    }
  }
  
  if (idx === -1) {
    const row = [
      userId,
      fields.step || "",
      fields.tempData || "",
      fields.lastMenu || "",
      fields.tempEmail || ""
    ];
    await appendRow("State", row);
  } else {
    const row = data[idx];
    while (row.length < 5) row.push("");
    
    if (fields.step !== undefined) row[1] = fields.step;
    if (fields.tempData !== undefined) row[2] = fields.tempData;
    if (fields.lastMenu !== undefined) row[3] = fields.lastMenu;
    if (fields.tempEmail !== undefined) row[4] = fields.tempEmail;
    
    await updateRow("State", idx + 1, row);
  }
}

async function getUserState(userId) {
  const data = await readSheet("State");
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(userId)) {
      return {
        step: data[i][1] || "",
        tempData: data[i][2] || "",
        lastMenu: data[i][3] || "",
        tempEmail: data[i][4] || "",
        rowIndex: i + 1
      };
    }
  }
  
  return { step: "", tempData: "", lastMenu: "", tempEmail: "" };
}

async function clearUserState(userId) {
  const data = await readSheet("State");
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(userId)) {
      await updateRow("State", i + 1, [userId, "", "", "", ""]);
      return;
    }
  }
}

// ========================================
// MENU MANAGEMENT
// ========================================

async function deleteMenuIfExists(userId, chatId, exceptMessageId = null) {
  try {
    const s = await getUserState(userId);
    const last = s.lastMenu;
    
    if (last && String(last) !== String(exceptMessageId)) {
      await deleteMessage(chatId, Number(last));
      await setUserStateFields(userId, { lastMenu: "" });
    }
  } catch (e) {
    console.error("deleteMenuIfExists error:", e.message);
  }
}

async function recordMenuMessage(userId, chatId, messageId) {
  await deleteMenuIfExists(userId, chatId, messageId);
  await setUserStateFields(userId, { lastMenu: String(messageId) });
}

// ========================================
// EMAIL & RATE LIMITING
// ========================================

async function canSendEmailToUser(userId, email) {
  const data = await readSheet("EmailLog");
  const idx = findIndexByFirstCol(data, userId);
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  
  if (idx > -1) {
    const row = data[idx];
    let count = Number(row[2] || 0);
    let lastSent = row[3] ? new Date(row[3]) : new Date(0);
    
    if (lastSent > oneDayAgo) {
      if (count >= 3) return false;
      row[2] = count + 1;
      row[3] = now.toISOString();
      await updateRow("EmailLog", idx + 1, row);
    } else {
      row[2] = 1;
      row[3] = now.toISOString();
      await updateRow("EmailLog", idx + 1, row);
    }
  } else {
    await appendRow("EmailLog", [userId, email || "", 1, now.toISOString()]);
  }
  
  return true;
}

async function sendEmailSafe(to, subject, htmlBody) {
  console.log(`📧 sendEmailSafe -> to:${to}, subject:${subject}`);
  
  try {
    await sendMessage(ADMIN_CHAT_ID, `📧 Email notification:\nTo: ${to}\nSubject: ${subject}`);
    return true;
  } catch (e) {
    console.error("sendEmailSafe failed:", e.message);
    return false;
  }
}

// Rate limiting for tickets (max 3 per 24h)
async function canSendTicket(userId) {
  const data = await readSheet("TicketRateLimits");
  const idx = findIndexByFirstCol(data, userId);
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  
  if (idx > -1) {
    const row = data[idx];
    let count = Number(row[1] || 0);
    let lastTicket = row[2] ? new Date(row[2]) : new Date(0);
    
    if (lastTicket > oneDayAgo) {
      if (count >= 3) return false;
      row[1] = count + 1;
      row[2] = now.toISOString();
      await updateRow("TicketRateLimits", idx + 1, row);
    } else {
      row[1] = 1;
      row[2] = now.toISOString();
      await updateRow("TicketRateLimits", idx + 1, row);
    }
  } else {
    await appendRow("TicketRateLimits", [userId, 1, now.toISOString()]);
  }
  
  return true;
}

async function getLessonByKey(key) {
  try {
    const data = await readSheet("Lessons");
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][1]) === String(key)) {
        return {
          id: data[i][0],
          key: data[i][1],
          title: data[i][2] || "",
          textContent: data[i][3] || "",
          videoLink: data[i][4] || "",
          isActive: (data[i][5] || "Yes").toString().toLowerCase() === "yes"
        };
      }
    }
  } catch (e) {
    console.error("getLessonByKey error:", e.message);
  }
  return null;
}

async function sendLesson(chatId, messageId, lessonKey, lessonTitle) {
  const lesson = await getLessonByKey(lessonKey);
  const backBtn = { inline_keyboard: [[{ text: "↩️ بازگشت به آموزش‌ها", callback_data: "edu_initial" }]] };

  if (!lesson) {
    // درس هنوز در شیت تعریف نشده
    await editMessageText(chatId, messageId,
      formatMessage(lessonTitle,
        "📌 محتوای این آموزش به زودی آماده می‌شود.\n\nاز شکیبایی شما سپاسگزاریم 🙏\n— تیم RBI24"
      ),
      backBtn
    );
    return;
  }

  if (!lesson.isActive) {
    await editMessageText(chatId, messageId,
      formatMessage(lesson.title || lessonTitle,
        "⏳ این آموزش در حال آماده‌سازی است.\n\nبه زودی در دسترس خواهد بود 🙏"
      ),
      backBtn
    );
    return;
  }

  let content = lesson.textContent || "محتوا موجود نیست.";

  // اگه ویدیو داشت، دکمه ویدیو اضافه کن
  const keyboard = { inline_keyboard: [] };
  if (lesson.videoLink && lesson.videoLink.trim() !== "") {
    keyboard.inline_keyboard.push([
      { text: "🎬 مشاهده ویدیو آموزشی", url: lesson.videoLink }
    ]);
  }
  keyboard.inline_keyboard.push([
    { text: "↩️ بازگشت به آموزش‌ها", callback_data: "edu_initial" }
  ]);

  await editMessageText(chatId, messageId,
    formatMessage(lesson.title || lessonTitle, content),
    keyboard
  );
}

// ========================================
// MAIN UPDATE HANDLER
// ========================================

async function handleUpdate(update) {
  try {
    const message = update.message;
    const callback = update.callback_query;
    
    if (!message && !callback) return;

    let chatId, text = "", from;
    
    if (message) {
      chatId = message.chat.id;
      text = (message.text || "").toString().trim();
      from = message.from;
    } else if (callback) {
      chatId = callback.message.chat.id;
      text = "";
      from = callback.from;
    }

    const firstName = from?.first_name || "";
    const lastName = from?.last_name || "";
    const username = from?.username || "";
    const userId = chatId;

    // Update user record (but don't overwrite email)
    await registerOrUpdateUser(userId, firstName, lastName, username, null, null);

    // ========================================
    // CALLBACK HANDLERS
    // ========================================
    
    if (callback) {
      await answerCallbackQuery(callback.id);
      const cd = callback.data;

      // --- ADMIN PANEL ---
      if (String(userId) === String(ADMIN_CHAT_ID)) {

        if (cd === "admin_stats") {
          await handleAdminStats(chatId, callback.message.message_id);
          return;
        }

        if (cd === "admin_broadcast") {
          await editMessageText(chatId, callback.message.message_id,
            formatMessage("📢 پیام همگانی",
              "متن پیامی که میخوای به <b>همه کاربران</b> ارسال بشه رو بفرست:\n\n" +
              "⚠️ این پیام برای تمام کاربران ثبت‌نام شده ارسال خواهد شد."
            ),
            { inline_keyboard: [[{ text: "❌ لغو", callback_data: "admin_close" }]] }
          );
          await setUserStateFields(userId, { step: "awaiting_broadcast_message" });
          return;
        }

        if (cd === "admin_filtered_broadcast") {
          await editMessageText(chatId, callback.message.message_id,
            formatMessage("🎯 پیام فیلتر شده",
              "لطفاً <b>ID کاربران</b> مورد نظر را ارسال کنید.\n\n" +
              "فرمت: هر ID در یک خط جداگانه:\n\n" +
              "<code>123456789\n987654321\n111222333</code>\n\n" +
              "یا با کاما جدا کنید:\n" +
              "<code>123456789, 987654321, 111222333</code>"
            ),
            { inline_keyboard: [[{ text: "❌ لغو", callback_data: "admin_close" }]] }
          );
          await setUserStateFields(userId, { step: "awaiting_filtered_ids" });
          return;
        }

        if (cd === "admin_tickets") {
          await handleAdminViewTickets(chatId, callback.message.message_id);
          return;
        }

        if (cd === "admin_backup") {
          await handleAdminBackup(chatId);
          return;
        }

        if (cd === "admin_announcements") {
          await editMessageText(chatId, callback.message.message_id,
            formatMessage("📋 مدیریت اطلاعیه",
              "برای افزودن اطلاعیه جدید، متن زیر را ارسال کنید:\n\n" +
              "<code>/announce عنوان | متن اطلاعیه</code>\n\n" +
              "مثال:\n" +
              "<code>/announce آپدیت سیستم | سیستم فردا ساعت ۲۲ آپدیت می‌شود</code>"
            ),
            { inline_keyboard: [[{ text: "❌ بستن", callback_data: "admin_close" }]] }
          );
          return;
        }

        if (cd === "admin_close") {
          await deleteMessage(chatId, callback.message.message_id);
          await clearUserState(userId);
          return;
        }

        // پاسخ تیکت با دکمه
        if (cd && cd.startsWith("admin_reply_ticket_")) {
          const ticketId = cd.replace("admin_reply_ticket_", "");
          await setUserStateFields(userId, { step: "awaiting_ticket_reply", tempData: ticketId });
          await editMessageText(chatId, callback.message.message_id,
            formatMessage("✍️ پاسخ به تیکت",
              `شماره تیکت: <code>${ticketId}</code>\n\nمتن پاسخ خود را تایپ کنید:`
            ),
            { inline_keyboard: [[{ text: "❌ لغو", callback_data: "admin_cancel_reply" }]] }
          );
          return;
        }

        if (cd === "admin_cancel_reply") {
          await clearUserState(userId);
          await editMessageText(chatId, callback.message.message_id,
            formatMessage("پنل ادمین", "عملیات لغو شد."),
            adminMenuKeyboard()
          );
          return;
        }
      }

      // --- BACK TO MAIN ---
      if (cd === "back_to_main") {
        await deleteMenuIfExists(userId, chatId, callback.message.message_id);
        const mid = await sendMessage(chatId,
          formatMessage("منوی اصلی RBI24", `سلام ${firstName} عزیز 👋\n\nلطفاً یکی از گزینه‌های زیر را انتخاب کنید:`),
          mainMenuKeyboard()
        );
        if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
        await logUserAction(userId, "back_to_main");
        return;
      }

      if (cd === "back_to_main_send") {
        await deleteMenuIfExists(userId, chatId);
        const mid = await sendMessage(chatId,
          formatMessage("منوی اصلی RBI24", `سلام ${firstName} عزیز 👋\n\nلطفاً یکی از گزینه‌های زیر را انتخاب کنید:`),
          mainMenuKeyboard()
        );
        if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
        return;
      }

      // --- آموزش‌های اولیه ---
      if (cd === "edu_initial") {
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("📖 آموزش‌های اولیه",
            "یکی از موضوعات آموزشی زیر را انتخاب کنید:"
          ),
          eduInitialKeyboard()
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await logUserAction(userId, "opened_edu_initial");
        return;
      }

      // --- درس‌های آموزشی ---
      const lessonMap = {
        "lesson_wallet_install":   "نحوه نصب ولت نرم‌افزاری",
        "lesson_wallet_transfer":  "دریافت و انتقال ارز از ولت شخصی",
        "lesson_exchange_buy":     "نحوه خرید ارز از صرافی دیجیتال",
        "lesson_exchange_sell":    "نحوه فروش ارز به صرافی دیجیتال",
        "lesson_fund_register":    "ثبت‌نام و احراز هویت در صندوق",
        "lesson_fund_contract":    "نحوه بستن قرارداد جدید در صندوق",
        "lesson_withdraw_profit":  "نحوه برداشت سود و کمیسیون",
        "lesson_2fa":              "فعال‌سازی کد دو عاملی گوگل",
        "lesson_position_id":      "نحوه استفاده از پوزیشن آیدی"
      };

      if (lessonMap[cd]) {
        await sendLesson(chatId, callback.message.message_id, cd, lessonMap[cd]);
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await logUserAction(userId, `viewed_${cd}`);
        return;
      }

      // --- FAQ ---
      if (cd === "faq_menu") {
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("❓ سوالات متداول", "یکی از دسته‌بندی‌های زیر را انتخاب کنید:"),
          faqMenuKeyboard()
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await logUserAction(userId, "opened_faq");
        return;
      }

      if (cd === "faq_about_fund") {
        const content =
          "🏦 <b>صندوق سرمایه‌گذاری RBI24 چیست؟</b>\n" +
          "یک صندوق آموزشی-سازمانی است که هدف آن استانداردسازی آموزش و رشد مرحله‌به‌مرحله اعضا می‌باشد.\n\n" +
          "📌 <b>چه کسانی می‌توانند عضو شوند؟</b>\n" +
          "هر فردی که قوانین و ساختار سازمانی را بپذیرد.\n\n" +
          "📌 <b>آیا نیاز به سرمایه اولیه است؟</b>\n" +
          "اطلاعات کامل در کانال‌های رسمی موجود است.";
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("درباره صندوق", content),
          { inline_keyboard: [[{ text: "↩️ بازگشت به FAQ", callback_data: "faq_menu" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      if (cd === "faq_profit") {
        const content =
          "💰 <b>نحوه محاسبه سود چگونه است؟</b>\n" +
          "جزئیات کامل در کانال رسمی آموزش‌ها موجود است.\n\n" +
          "📌 <b>کمیسیون چیست؟</b>\n" +
          "کمیسیون بر اساس ساختار سازمانی و رنک شما محاسبه می‌شود.\n\n" +
          "📌 <b>زمان‌بندی پرداخت؟</b>\n" +
          "اطلاعیه‌های رسمی از طریق کانال‌ها اعلام می‌شود.";
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("سود و کمیسیون", content),
          { inline_keyboard: [[{ text: "↩️ بازگشت به FAQ", callback_data: "faq_menu" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      if (cd === "faq_security") {
        const content =
          "🔒 <b>آیا اطلاعات من امن است؟</b>\n" +
          "بله، اطلاعات شما فقط برای تایید هویت استفاده می‌شود.\n\n" +
          "📌 <b>قوانین مهم:</b>\n" +
          "• هیچ‌کس از طرف RBI24 رمز یا ولت شما را نمی‌خواهد\n" +
          "• تراکنش‌ها فقط از طریق کانال رسمی اطلاع‌رسانی می‌شود\n" +
          "• در صورت مشاهده رفتار مشکوک فوراً تیکت ارسال کنید";
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("امنیت و قوانین", content),
          { inline_keyboard: [[{ text: "↩️ بازگشت به FAQ", callback_data: "faq_menu" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      if (cd === "faq_support") {
        const content =
          "📞 <b>چطور با پشتیبانی تماس بگیرم؟</b>\n\n" +
          "🎫 ارسال تیکت از منوی پشتیبانی (توصیه می‌شود)\n\n" +
          "📧 ایمیل: support@rbi24.com\n\n" +
          "⏱ زمان پاسخ‌گویی: ۲۴ تا ۴۸ ساعت کاری";
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("پشتیبانی", content),
          { inline_keyboard: [[{ text: "↩️ بازگشت به FAQ", callback_data: "faq_menu" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      // --- ABOUT ---
      if (cd === "about_menu") {
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("ℹ️ درباره ما", "برای دریافت اطلاعات بیشتر، یکی از بخش‌ها را انتخاب کنید:"),
          aboutMenuKeyboard()
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await logUserAction(userId, "opened_about");
        return;
      }

      if (cd === "about_mission") {
        const content =
          "🎯 <b>ماموریت ما:</b>\n\n" +
          "سیستم آموزشی RBI24 با هدف:\n" +
          "• استانداردسازی آموزش‌ها\n" +
          "• کاهش خطای انسانی\n" +
          "• یکسان‌سازی پیام‌ها\n" +
          "• رشد مرحله‌به‌مرحله افراد\n\n" +
          "طراحی شده است.";
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("ماموریت ما", content),
          { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "about_menu" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      if (cd === "about_structure") {
        const content =
          "🏗️ <b>ساختار سازمانی RBI24:</b>\n\n" +
          "🔹 <b>Starter</b> — مرحله ورود و یادگیری پایه\n\n" +
          "🔹 <b>Supporter</b> — مرحله اثرگذاری اولیه\n\n" +
          "🔹 <b>Doer</b> — مرحله اجرا و مسئولیت‌پذیری\n\n" +
          "🔹 <b>Advisor</b> — مرحله راهبری و هدایت\n\n" +
          "📌 ارتقای رنک توسط تیم انسانی تعیین می‌شود.";
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("ساختار سازمانی", content),
          { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "about_menu" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      if (cd === "about_rules") {
        const content =
          "📜 <b>قوانین و مقررات مهم:</b>\n\n" +
          "✅ رعایت ادب و احترام در تمام تعاملات\n" +
          "✅ عدم اشتراک‌گذاری اطلاعات خصوصی\n" +
          "✅ پیروی از دستورالعمل‌های رسمی\n" +
          "✅ استفاده از کانال‌های رسمی برای دریافت اطلاعات\n\n" +
          "❌ هرگونه فعالیت خارج از چارچوب مجاز نیست.";
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("قوانین و مقررات", content),
          { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "about_menu" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      if (cd === "about_channels") {
        const content =
          `📡 <b>کانال‌های رسمی RBI24:</b>\n\n` +
          `🔹 Starter: ${CHANNELS.starter}\n` +
          `🔹 Supporter: ${CHANNELS.supporter}\n` +
          `🔹 Doer: ${CHANNELS.doer}\n` +
          `🔹 Advisor: ${CHANNELS.advisor}\n\n` +
          `⚠️ فقط این کانال‌ها رسمی هستند.\n` +
          `در کانال‌های دیگر اطلاعات دریافت نکنید.`;
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("کانال‌های رسمی", content),
          { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "about_menu" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      // --- SUPPORT ---
      if (cd === "support_menu") {
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("🛟 پشتیبانی RBI24", "ما همیشه کنار شما هستیم 💙\n\nیکی از گزینه‌ها را انتخاب کنید:"),
          supportMenuKeyboard()
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await logUserAction(userId, "opened_support");
        return;
      }

      if (cd === "support_email") {
        await editMessageText(chatId, callback.message.message_id,
          formatMessage("📧 پشتیبانی ایمیلی",
            "لطفاً با ایمیل زیر تماس بگیرید:\n\n<b>support@rbi24.com</b>\n\n⏱ زمان پاسخ: ۲۴ تا ۴۸ ساعت کاری"
          ),
          { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "support_menu" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      if (cd === "support_ticket") {
        const canSend = await canSendTicket(userId);
        if (!canSend) {
          await answerCallbackQuery(callback.id, "⚠️ حداکثر ۳ تیکت در ۲۴ ساعت مجاز است.");
          return;
        }

        const userRec = await getUserById(userId);
        await deleteMenuIfExists(userId, chatId);

        if (userRec && userRec.email && userRec.emailConfirmed === "Yes") {
          await setUserStateFields(userId, { step: "awaiting_ticket_message", tempData: userRec.email });
          await sendMessage(chatId,
            formatMessage("🎫 ارسال تیکت",
              "لطفاً پیام تیکت خود را وارد کنید:\n\n(ایمیل ثبت‌شده شما به‌صورت خودکار ضمیمه می‌شود)"
            ),
            { inline_keyboard: [[{ text: "↩️ لغو", callback_data: "back_to_main_send" }]] }
          );
        } else {
          await setUserStateFields(userId, { step: "awaiting_ticket_email_1", tempData: "" });
          await sendMessage(chatId,
            formatMessage("🎫 ارسال تیکت", "📧 لطفاً ایمیل خود را وارد کنید:\n(مثال: example@domain.com)"),
            { inline_keyboard: [[{ text: "↩️ لغو", callback_data: "back_to_main_send" }]] }
          );
        }
        await logUserAction(userId, "started_ticket");
        return;
      }

      return;

// [CALLBACKS_END]

    // ========================================
    // TEXT MESSAGE HANDLERS
    // ========================================
    
    const state = await getUserState(userId);
    const step = state.step || "";

    //// --- ADMIN: /admin command ---
    if (String(userId) === String(ADMIN_CHAT_ID) && text === "/admin") {
      await deleteMenuIfExists(userId, chatId);
      const mid = await sendMessage(chatId,
        formatMessage("🔐 پنل مدیریت RBI24",
          `👋 خوش آمدید\n\n` +
          `🕐 ${getNow()}\n\n` +
          `برای مدیریت، یکی از گزینه‌های زیر را انتخاب کنید:`
        ),
        adminMenuKeyboard()
      );
      if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
      return;
    }

    // --- ADMIN: /announce ---
    if (String(userId) === String(ADMIN_CHAT_ID) && text && text.startsWith("/announce ")) {
      const parts = text.replace("/announce ", "").split("|");
      const title = (parts[0] || "").trim();
      const msg = (parts[1] || "").trim();

      if (!title || !msg) {
        await sendMessage(chatId, formatMessage("خطا",
          "فرمت صحیح:\n<code>/announce عنوان | متن اطلاعیه</code>"
        ));
        return;
      }

      const id = `ANN_${Date.now()}`;
      await appendRow("Announcements", [id, title, msg, getNow(), "Yes"]);
      await sendMessage(chatId, formatMessage("✅ اطلاعیه ثبت شد",
        `عنوان: ${title}\n\nمتن: ${msg}`
      ));
      return;
    }

    // --- ADMIN: Broadcast ---
    if (String(userId) === String(ADMIN_CHAT_ID) && step === "awaiting_broadcast_message" && text) {
      await handleBroadcast(chatId, text);
      await clearUserState(userId);
      return;
    }

    // --- ADMIN: Filtered Broadcast - دریافت لیست ID ها ---
    if (String(userId) === String(ADMIN_CHAT_ID) && step === "awaiting_filtered_ids" && text) {
      // پارس کردن ID ها (با خط جدید یا کاما)
      const rawIds = text.replace(/,/g, "\n").split("\n")
        .map(s => s.trim())
        .filter(s => s.length > 0);

      if (rawIds.length === 0) {
        await sendMessage(chatId, formatMessage("خطا", "❌ هیچ ID معتبری یافت نشد."));
        await clearUserState(userId);
        return;
      }

      await setUserStateFields(userId, {
        step: "awaiting_filtered_message",
        tempData: rawIds.join(",")
      });

      await sendMessage(chatId,
        formatMessage("🎯 پیام فیلتر شده",
          `✅ ${rawIds.length} کاربر انتخاب شد.\n\nحالا متن پیام را ارسال کنید:`
        ),
        { inline_keyboard: [[{ text: "❌ لغو", callback_data: "admin_close" }]] }
      );
      return;
    }

    // --- ADMIN: Filtered Broadcast - ارسال پیام ---
    if (String(userId) === String(ADMIN_CHAT_ID) && step === "awaiting_filtered_message" && text) {
      const targetIds = (state.tempData || "").split(",").filter(s => s.trim());
      await handleFilteredBroadcast(chatId, targetIds, text);
      await clearUserState(userId);
      return;
    }

    // --- ADMIN: Ticket reply ---
    if (String(userId) === String(ADMIN_CHAT_ID) && step === "awaiting_ticket_reply" && text) {
      const ticketId = state.tempData || "";
      const tickets = await readSheet("Tickets");
      let ticketRowIdx = -1;
      let ticketRow = null;

      for (let i = 1; i < tickets.length; i++) {
        if (String(tickets[i][0]) === String(ticketId)) {
          ticketRowIdx = i;
          ticketRow = tickets[i];
          break;
        }
      }

      if (!ticketRow) {
        await sendMessage(chatId, formatMessage("خطا", "❌ تیکت پیدا نشد."));
        await clearUserState(userId);
        return;
      }

      const targetUserId = ticketRow[1];
      const email = ticketRow[2] || "";
      const now = getNow();

      ticketRow[4] = text;
      ticketRow[6] = now;
      ticketRow[7] = "No";
      await updateRow("Tickets", ticketRowIdx + 1, ticketRow);

      try {
        await sendMessage(targetUserId,
          formatMessage("📢 پاسخ تیکت",
            `شماره تیکت: <code>${ticketId}</code>\n\n${text}`
          ),
          { inline_keyboard: [[{ text: "↩️ منوی اصلی", callback_data: "back_to_main_send" }]] }
        );
        ticketRow[7] = "Yes";
        await updateRow("Tickets", ticketRowIdx + 1, ticketRow);
      } catch (e) {
        console.error("ticket reply send failed:", e.message);
      }

      await clearUserState(userId);
      await sendMessage(chatId,
        formatMessage("✅ پاسخ ارسال شد",
          `پاسخ به تیکت ${ticketId} با موفقیت ارسال شد.`
        ),
        adminMenuKeyboard()
      );
      return;
    }

    // --- /START ---
    if (text === "/start") {
      await deleteMenuIfExists(userId, chatId);
      const user = await getUserById(userId);

      if (user && user.email && user.emailConfirmed === "Yes") {
        const mid = await sendMessage(chatId, 
          formatMessage("خوش آمدید به RBI24", `سلام ${firstName} عزیز 👋\n\nلطفاً یکی از گزینه‌های زیر را انتخاب کنید:`), 
          mainMenuKeyboard()
        );
        if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
        await logUserAction(userId, "start_command");
      } else {
        await setUserStateFields(userId, { step: "awaiting_email_1", tempData: "" });
        await sendMessage(chatId, 
          formatMessage("خوش آمدید", "🌟 سلام! برای شروع، لطفاً ایمیل خود را وارد کنید:\n\n(مثال: example@domain.com)")
        );
        await logUserAction(userId, "start_new_user");
      }
      
      return;
    }

    // --- EMAIL REGISTRATION (Step 1) ---
    if (step === "awaiting_email_1" && text) {
      if (!isValidEmail(text)) {
        await sendMessage(chatId, 
          formatMessage("ایمیل نامعتبر", "❌ لطفاً یک ایمیل معتبر وارد کنید:\n\n(مثال: example@domain.com)")
        );
        return;
      }
      
      const users = await readSheet("Users");
      const exists = users.find((r, i) => 
        i > 0 && 
        String(r[4] || "").toLowerCase() === text.toLowerCase() && 
        String(r[0]) !== String(userId)
      );
      
      if (exists) {
        await sendMessage(chatId, 
          formatMessage("ایمیل تکراری", "❌ این ایمیل قبلاً توسط کاربر دیگری ثبت شده است.\n\nلطفاً ایمیل دیگری وارد کنید:")
        );
        return;
      }
      
      await setUserStateFields(userId, { step: "awaiting_email_2", tempData: text });
      await sendMessage(chatId, 
        formatMessage("تایید ایمیل", "✅ لطفاً ایمیل خود را مجدداً وارد کنید تا از صحت آن اطمینان حاصل شود:")
      );
      return;
    }

    // --- EMAIL REGISTRATION (Step 2 - Confirm) ---
    if (step === "awaiting_email_2" && text) {
      const firstEmail = state.tempData || "";
      
      if (text.toLowerCase() !== firstEmail.toLowerCase()) {
        await sendMessage(chatId, 
          formatMessage("عدم تطابق", "❌ ایمیل وارد شده با ایمیل قبلی مطابقت ندارد.\n\nلطفاً دوباره از ابتدا ایمیل خود را وارد کنید:")
        );
        await setUserStateFields(userId, { step: "awaiting_email_1", tempData: "" });
        return;
      }
      
      await registerOrUpdateUser(userId, firstName, lastName, username, firstEmail, "Yes");
      
      if (await canSendEmailToUser(userId, firstEmail)) {
        await sendEmailSafe(firstEmail, "خوش آمدید به RBI24", 
          `<p>سلام ${firstName} عزیز،</p><p>به سیستم آموزشی RBI24 خوش آمدید!</p>`
        );
      }
      
      await deleteMenuIfExists(userId, chatId);
      const mid = await sendMessage(chatId, 
        formatMessage("ثبت‌نام موفق", `✅ ایمیل شما با موفقیت ثبت شد!\n\nحالا می‌توانید از منوها استفاده کنید.`), 
        mainMenuKeyboard()
      );
      if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
      await clearUserState(userId);
      await logUserAction(userId, "email_registered");
      return;
    }

    // Continue in next part...

    // --- TICKET: Email Step 1 ---
    if (step === "awaiting_ticket_email_1" && text) {
      if (!isValidEmail(text)) {
        await sendMessage(chatId,
          formatMessage("ایمیل نامعتبر", "❌ لطفاً یک ایمیل معتبر وارد کنید:\n\n(مثال: example@domain.com)")
        );
        return;
      }

      await setUserStateFields(userId, { step: "awaiting_ticket_email_2", tempData: text });
      await sendMessage(chatId,
        formatMessage("تایید ایمیل", "✅ لطفاً ایمیل خود را مجدداً وارد کنید تا از صحت آن اطمینان حاصل شود:")
      );
      return;
    }

    // --- TICKET: Email Step 2 (Confirm) ---
    if (step === "awaiting_ticket_email_2" && text) {
      const firstEmail = state.tempData || "";

      if (text.toLowerCase() !== firstEmail.toLowerCase()) {
        await sendMessage(chatId,
          formatMessage("عدم تطابق", "❌ ایمیل وارد شده مطابقت ندارد.\n\nلطفاً از ابتدا وارد کنید:")
        );
        await setUserStateFields(userId, { step: "awaiting_ticket_email_1", tempData: "" });
        return;
      }

      await setUserStateFields(userId, { step: "awaiting_ticket_message", tempData: firstEmail });
      await sendMessage(chatId,
        formatMessage("پیام تیکت", "🎫 لطفاً پیام تیکت خود را وارد کنید:"),
        { inline_keyboard: [[{ text: "↩️ لغو", callback_data: "back_to_main_send" }]] }
      );
      return;
    }

    // --- TICKET: Message ---
    if (step === "awaiting_ticket_message" && text) {
      const email = state.tempData || "";
      const tid = `TKT_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const createdAt = getNow();

      await appendRow("Tickets", [tid, userId, email, text, "", createdAt, "", "No"]);
      await clearUserState(userId);
      await deleteMenuIfExists(userId, chatId);

      await sendMessage(chatId,
        formatMessage("تیکت ثبت شد",
          `✅ تیکت شما با موفقیت ثبت شد!\n\n🔖 شماره تیکت: <code>${tid}</code>\n\nتیم پشتیبانی به زودی پاسخ خواهد داد.`
        ),
        { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main_send" }]] }
      );

      await sendMessage(ADMIN_CHAT_ID,
        `🎫 <b>تیکت جدید!</b>\n` +
        `👤 کاربر: ${firstName} (@${username || "ندارد"})\n` +
        `🆔 UserID: ${userId}\n` +
        `📧 ایمیل: ${email}\n` +
        `📝 متن:\n${text}\n` +
        `🔖 شناسه: ${tid}\n\n` +
        `برای پاسخ: /reply_${tid}`
      );

      if (await canSendEmailToUser(userId, email)) {
        await sendEmailSafe(email, "تیکت شما دریافت شد - RBI24",
          `<p>سلام ${firstName} عزیز،</p><p>تیکت شما دریافت شد. به زودی پاسخ خواهید گرفت.</p><p>شماره تیکت: ${tid}</p>`
        );
      }

      await logUserAction(userId, "ticket_submitted");
      return;
    }

    // --- ADMIN: Reply to ticket via /reply_TICKETID ---
    if (String(userId) === String(ADMIN_CHAT_ID) && text && text.startsWith("/reply_")) {
      const ticketId = text.replace("/reply_", "").trim();
      await setUserStateFields(userId, { step: "awaiting_ticket_reply", tempData: ticketId });
      await sendMessage(chatId,
        formatMessage("پاسخ تیکت", `در حال پاسخ به تیکت:\n<code>${ticketId}</code>\n\nمتن پاسخ خود را وارد کنید:`),
        { inline_keyboard: [[{ text: "❌ لغو", callback_data: "admin_close" }]] }
      );
      return;
    }

    // --- ADMIN: Save ticket reply ---
    if (String(userId) === String(ADMIN_CHAT_ID) && step === "awaiting_ticket_reply" && text) {
      const ticketId = state.tempData || "";

      const tickets = await readSheet("Tickets");
      let ticketRowIdx = -1;
      let ticketRow = null;

      for (let i = 1; i < tickets.length; i++) {
        if (String(tickets[i][0]) === String(ticketId)) {
          ticketRowIdx = i;
          ticketRow = tickets[i];
          break;
        }
      }

      if (!ticketRow) {
        await sendMessage(chatId, formatMessage("خطا", "❌ تیکت پیدا نشد."));
        await clearUserState(userId);
        return;
      }

      const targetUserId = ticketRow[1];
      const email = ticketRow[2] || "";
      const now = getNow();

      ticketRow[4] = text;
      ticketRow[6] = now;
      ticketRow[7] = "No";

      await updateRow("Tickets", ticketRowIdx + 1, ticketRow);

      try {
        await sendMessage(targetUserId,
          formatMessage("پاسخ تیکت",
            `📢 پاسخ تیکت شما به شماره:\n<code>${ticketId}</code>\n\nبه شرح زیر می‌باشد:\n\n${text}`
          ),
          { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main_send" }]] }
        );

        ticketRow[7] = "Yes";
        await updateRow("Tickets", ticketRowIdx + 1, ticketRow);
      } catch (e) {
        console.error("Failed to send ticket reply:", e.message);
      }

      await clearUserState(userId);
      await sendMessage(chatId,
        formatMessage("پاسخ ارسال شد", `✅ پاسخ به تیکت ${ticketId} با موفقیت ارسال شد.`)
      );
      return;
    }

    // --- DEFAULT: Unknown message ---
    if (text && !step) {
      await deleteMenuIfExists(userId, chatId);
      const mid = await sendMessage(chatId,
        formatMessage("RBI24", `سلام ${firstName} عزیز 👋\n\nلطفاً از منوی زیر استفاده کنید:`),
        mainMenuKeyboard()
      );
      if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
      await logUserAction(userId, "unknown_message");
      return;
    }

  } catch (err) {
    console.error("❌ handleUpdate error:", err);
    try {
      await sendMessage(ADMIN_CHAT_ID, `⚠️ Bot Error:\n${String(err)}`);
    } catch(e) {}
  }
}

// ========================================
// ADMIN FUNCTIONS
// ========================================

async function handleAdminStats(chatId, messageId) {
  try {
    const users = await readSheet("Users");
    const tickets = await readSheet("Tickets");

    const totalUsers = Math.max(0, users.length - 1);

    let openTickets = 0;
    let closedTickets = 0;
    for (let i = 1; i < tickets.length; i++) {
      if ((tickets[i][4] || "").trim()) closedTickets++;
      else openTickets++;
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    let activeUsers = 0;
    for (let i = 1; i < users.length; i++) {
      const last = users[i][7] ? new Date(users[i][7]) : null;
      if (last && last > sevenDaysAgo) activeUsers++;
    }

    const content =
      `👥 کل کاربران: <b>${totalUsers}</b>\n` +
      `📊 کاربران فعال (7 روز): <b>${activeUsers}</b>\n\n` +
      `🎫 تیکت‌های باز: <b>${openTickets}</b>\n` +
      `✅ تیکت‌های بسته: <b>${closedTickets}</b>\n\n` +
      `🕐 آخرین به‌روزرسانی: ${getNow()}`;

    await editMessageText(chatId, messageId,
      formatMessage("آمار سیستم", content),
      { inline_keyboard: [[{ text: "↩️ بستن", callback_data: "admin_close" }]] }
    );
  } catch (e) {
    await sendMessage(chatId, formatMessage("خطا", "❌ خطا در دریافت آمار."));
  }
}

async function handleAdminViewTickets(chatId, messageId) {
  try {
    const tickets = await readSheet("Tickets");
    const openTickets = [];

    for (let i = 1; i < tickets.length; i++) {
      const row = tickets[i];
      if (!(row[4] || "").trim()) {
        openTickets.push({ row, idx: i });
      }
    }

    if (openTickets.length === 0) {
      await editMessageText(chatId, messageId,
        formatMessage("🎫 تیکت‌های باز", "✅ در حال حاضر تیکت باز وجود ندارد."),
        { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "admin_close" }]] }
      );
      return;
    }

    // نمایش ۵ تیکت اول + دکمه پاسخ برای هر کدام
    const showTickets = openTickets.slice(0, 5);
    let content = `<b>${openTickets.length} تیکت باز</b> (نمایش ${showTickets.length}):\n\n`;

    const keyboard = { inline_keyboard: [] };

    for (const { row } of showTickets) {
      const tid = row[0] || "";
      const uid = row[1] || "";
      const email = row[2] || "";
      const msg = (row[3] || "").substring(0, 60);
      const date = row[5] || "";

      content += `🔖 <code>${tid}</code>\n`;
      content += `👤 ${uid} | ${email}\n`;
      content += `📝 ${msg}${msg.length >= 60 ? "..." : ""}\n`;
      content += `🗓 ${date}\n\n`;

      keyboard.inline_keyboard.push([
        { text: `✍️ پاسخ به ${tid.substring(0, 15)}...`, callback_data: `admin_reply_ticket_${tid}` }
      ]);
    }

    keyboard.inline_keyboard.push([{ text: "↩️ بازگشت", callback_data: "admin_close" }]);

    await editMessageText(chatId, messageId,
      formatMessage("🎫 تیکت‌های باز", content),
      keyboard
    );
  } catch (e) {
    console.error("handleAdminViewTickets error:", e.message);
    await sendMessage(chatId, formatMessage("خطا", "❌ خطا در دریافت تیکت‌ها."));
  }
}

async function handleAdminBackup(chatId) {
  try {
    await sendMessage(chatId, "⏳ در حال آماده‌سازی بکاپ...");

    const sheetNames = [
      "Users", "State", "Tickets", "EmailLog",
      "InvestRequests", "WithdrawRequests",
      "BroadcastLogs", "Announcements", "FAQ",
      "UserActions", "TicketRateLimits"
    ];

    const backup = { exportedAt: getNow(), version: "2.0", sheets: {} };

    for (const name of sheetNames) {
      try { backup.sheets[name] = await readSheet(name); }
      catch (e) { backup.sheets[name] = []; }
    }

    const summary = { exportedAt: backup.exportedAt, sheetCounts: {} };
    for (const [k, v] of Object.entries(backup.sheets)) {
      summary.sheetCounts[k] = Array.isArray(v) ? Math.max(0, v.length - 1) : 0;
    }

    await sendMessage(chatId,
      `💾 <b>بکاپ دیتابیس (خلاصه)</b>\n\n<pre>${JSON.stringify(summary, null, 2)}</pre>\n\n` +
      `برای دانلود کامل فایل JSON، در مرورگر باز کنید:\n` +
      `<code>/admin/backup?secret=YOUR_SECRET</code>`
    );
  } catch (e) {
    await sendMessage(chatId, "❌ خطا در ایجاد بکاپ.");
  }
}

async function handleBroadcast(chatId, messageText) {
  try {
    await sendMessage(chatId, "📢 در حال ارسال پیام همگانی...");

    const users = await readSheet("Users");
    let sent = 0, failed = 0;
    const broadcastId = `BC_${Date.now()}`;
    const now = getNow();

    for (let i = 1; i < users.length; i++) {
      const targetId = users[i][0];
      if (!targetId) continue;

      try {
        const mid = await sendMessage(targetId,
          formatMessage("اطلاعیه رسمی RBI24", messageText)
        );
        if (mid) {
          sent++;
          await appendRow("BroadcastLogs", [broadcastId, targetId, mid, now, "No"]);
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }

      await sleep(50);
    }

    await sendMessage(chatId,
      formatMessage("نتیجه ارسال",
        `✅ ارسال شد: ${sent}\n❌ ناموفق: ${failed}\n🆔 شناسه: ${broadcastId}`
      )
    );
  } catch (e) {
    await sendMessage(chatId, "❌ خطا در ارسال پیام همگانی.");
  }
}

async function handleFilteredBroadcast(chatId, targetIds, messageText) {
  try {
    await sendMessage(chatId, `⏳ در حال ارسال پیام به ${targetIds.length} کاربر...`);

    let sent = 0, failed = 0;
    const broadcastId = `FBC_${Date.now()}`;
    const now = getNow();

    for (const targetId of targetIds) {
      const id = targetId.trim();
      if (!id) continue;

      try {
        const mid = await sendMessage(id,
          formatMessage("📨 پیام اختصاصی RBI24", messageText)
        );
        if (mid) {
          sent++;
          await appendRow("BroadcastLogs", [broadcastId, id, mid, now, "No"]);
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }

      await sleep(50);
    }

    // ذخیره لاگ خلاصه
    await appendRow("FilteredBroadcast", [
      broadcastId,
      targetIds.join(","),
      messageText.substring(0, 100),
      now,
      sent
    ]);

    await sendMessage(chatId,
      formatMessage("✅ نتیجه ارسال",
        `✅ ارسال موفق: ${sent}\n❌ ناموفق: ${failed}\n🆔 شناسه: ${broadcastId}`
      ),
      adminMenuKeyboard()
    );
  } catch (e) {
    console.error("handleFilteredBroadcast error:", e.message);
    await sendMessage(chatId, "❌ خطا در ارسال پیام فیلتر شده.");
  }
}

// ========================================
// EXPRESS ROUTES
// ========================================

app.post('/webhook', async (req, res) => {
  const update = req.body;
  res.status(200).send('ok');
  try {
    await handleUpdate(update);
  } catch (e) {
    console.error('❌ processing update failed:', e);
  }
});

app.get('/', (req, res) => res.send('✅ RBI24 Bot v2.0 running'));

// Admin Sync
app.get('/admin/sync', async (req, res) => {
  const secret = req.query.secret || "";
  if (!ADMIN_SYNC_SECRET || secret !== ADMIN_SYNC_SECRET) {
    return res.status(403).send('Forbidden');
  }

  try {
    const tickets = await readSheet("Tickets");

    for (let i = 1; i < tickets.length; i++) {
      const row = tickets[i];
      const ticketId = row[0];
      const targetUserId = row[1];
      const email = row[2] || "";
      const message = row[3] || "";
      const answer = row[4] || "";
      const createdAt = row[5] || "";
      const notified = (row[7] || "").toString().toLowerCase();

      if (answer && notified !== 'yes') {
        try {
          await sendMessage(targetUserId,
            formatMessage("پاسخ تیکت",
              `📢 پاسخ تیکت شما:\n<code>${ticketId}</code>\n\n${answer}`
            ),
            { inline_keyboard: [[{ text: "↩️ منوی اصلی", callback_data: "back_to_main_send" }]] }
          );
        } catch (e) {
          console.error("sync ticket send failed:", e.message);
        }

        const now = getNow();
        await updateRow("Tickets", i + 1,
          [ticketId, targetUserId, email, message, answer, createdAt, now, "Yes"]
        );
      }
    }

    res.send('✅ Sync completed');
  } catch (e) {
    console.error("admin sync error:", e);
    res.status(500).send('Error');
  }
});

// Full JSON Backup Download
app.get('/admin/backup', async (req, res) => {
  const secret = req.query.secret || "";
  if (!ADMIN_SYNC_SECRET || secret !== ADMIN_SYNC_SECRET) {
    return res.status(403).send('Forbidden');
  }

  try {
    const sheetNames = [
      "Users", "State", "Tickets", "EmailLog",
      "InvestRequests", "WithdrawRequests",
      "BroadcastLogs", "Announcements", "FAQ",
      "UserActions", "TicketRateLimits"
    ];

    const backup = { exportedAt: getNow(), version: "2.0", sheets: {} };

    for (const name of sheetNames) {
      try { backup.sheets[name] = await readSheet(name); }
      catch (e) { backup.sheets[name] = []; }
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition',
      `attachment; filename="rbi24_backup_${Date.now()}.json"`
    );
    res.send(JSON.stringify(backup, null, 2));
  } catch (e) {
    res.status(500).send('Error');
  }
});

// Admin Stats API
app.get('/admin/stats', async (req, res) => {
  const secret = req.query.secret || "";
  if (!ADMIN_SYNC_SECRET || secret !== ADMIN_SYNC_SECRET) {
    return res.status(403).send('Forbidden');
  }

  try {
    const users = await readSheet("Users");
    const tickets = await readSheet("Tickets");
    const totalUsers = Math.max(0, users.length - 1);

    let openTickets = 0, closedTickets = 0;
    for (let i = 1; i < tickets.length; i++) {
      if ((tickets[i][4] || "").trim()) closedTickets++;
      else openTickets++;
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    let activeUsers = 0;
    for (let i = 1; i < users.length; i++) {
      const last = users[i][7] ? new Date(users[i][7]) : null;
      if (last && last > sevenDaysAgo) activeUsers++;
    }

    res.json({
      timestamp: getNow(),
      users: { total: totalUsers, activeLastWeek: activeUsers },
      tickets: { open: openTickets, closed: closedTickets }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========================================
// STARTUP
// ========================================

async function main() {
  console.log("🚀 Starting RBI24 Bot v2.0...");
  await initSheetsClient();
  await ensureSheetHeaders();

  app.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}`);
  });
}

main().catch(err => {
  console.error('❌ Fatal startup error:', err);
  process.exit(1);
});



    

