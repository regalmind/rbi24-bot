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
      [{ text: "📚 آموزش‌ها و چنل‌ها", callback_data: "edu_channels" }],
      [{ text: "📢 آخرین اطلاعیه‌ها", callback_data: "announcements" }],
      [{ text: "❓ سوالات متداول (FAQ)", callback_data: "faq_menu" }],
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

function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📊 آمار سیستم", callback_data: "admin_stats" }],
      [{ text: "📢 ارسال پیام همگانی", callback_data: "admin_broadcast" }],
      [{ text: "🎫 مشاهده تیکت‌های باز", callback_data: "admin_tickets" }],
      [{ text: "💾 بکاپ دیتابیس", callback_data: "admin_backup" }],
      [{ text: "↩️ بستن منو", callback_data: "admin_close" }]
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

      // --- ADMIN COMMANDS (only for ADMIN_CHAT_ID) ---
      if (String(userId) === String(ADMIN_CHAT_ID)) {
        if (cd === "admin_stats") {
          await handleAdminStats(chatId, callback.message.message_id);
          return;
        }
        
        if (cd === "admin_broadcast") {
          await editMessageText(chatId, callback.message.message_id, 
            formatMessage("ارسال پیام همگانی", "لطفاً متن پیام خود را ارسال کنید:"), 
            { inline_keyboard: [[{ text: "❌ لغو", callback_data: "admin_close" }]] }
          );
          await setUserStateFields(userId, { step: "awaiting_broadcast_message" });
          return;
        }
        
        if (cd === "admin_tickets") {
          await handleAdminViewTickets(chatId, callback.message.message_id);
          return;
        }
        
        if (cd === "admin_backup") {
          await handleAdminBackup(chatId);
          await answerCallbackQuery(callback.id, "بکاپ در حال ارسال...");
          return;
        }
        
        if (cd === "admin_close") {
          await deleteMessage(chatId, callback.message.message_id);
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
        await logUserAction(userId, "back_to_main_send");
        return;
      }

      // --- EDUCATION & CHANNELS ---
      if (cd === "edu_channels") {
        const content = `📚 <b>چنل‌های آموزشی RBI24</b>\n\n` +
          `🔹 چنل Starter: ${CHANNELS.starter}\n` +
          `🔹 چنل Supporter: ${CHANNELS.supporter}\n` +
          `🔹 چنل Doer: ${CHANNELS.doer}\n` +
          `🔹 چنل Advisor: ${CHANNELS.advisor}\n\n` +
          `💡 لطفاً بر اساس رنک خود، در چنل مربوطه عضو شوید.\n` +
          `تمام آموزش‌ها در چنل‌ها منتشر می‌شود.`;
        
        await editMessageText(chatId, callback.message.message_id, 
          formatMessage("آموزش‌ها و چنل‌ها", content), 
          { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "back_to_main" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await logUserAction(userId, "viewed_channels");
        return;
      }

      // --- ANNOUNCEMENTS ---
      if (cd === "announcements") {
        const announcements = await readSheet("Announcements");
        let content = "";
        
        let count = 0;
        for (let i = announcements.length - 1; i >= 1 && count < 3; i--) {
          const row = announcements[i];
          const isActive = (row[4] || "").toString().toLowerCase();
          
          if (isActive === "yes") {
            const title = row[1] || "بدون عنوان";
            const msg = row[2] || "";
            const date = row[3] || "";
            content += `📌 <b>${title}</b>\n${msg}\n🗓 ${date}\n\n`;
            count++;
          }
        }
        
        if (!content) {
          content = "در حال حاضر اطلاعیه‌ای موجود نیست.";
        }
        
        await editMessageText(chatId, callback.message.message_id, 
          formatMessage("آخرین اطلاعیه‌ها", content), 
          { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "back_to_main" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await logUserAction(userId, "viewed_announcements");
        return;
      }

      // --- FAQ MENU ---
      if (cd === "faq_menu") {
        const faqData = await readSheet("FAQ");
        let content = "";
        
        if (faqData.length > 1) {
          for (let i = 1; i < faqData.length && i <= 5; i++) {
            const row = faqData[i];
            const question = row[2] || "";
            const answer = row[3] || "";
            content += `❓ <b>${question}</b>\n💡 ${answer}\n\n`;
          }
        } else {
          content = "محتوای این بخش در حال آماده‌سازی است.\nاز شکیبایی شما متشکریم.";
        }
        
        await editMessageText(chatId, callback.message.message_id, 
          formatMessage("سوالات متداول", content), 
          { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "back_to_main" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await logUserAction(userId, "viewed_faq");
        return;
      }

      // --- ABOUT ---
      if (cd === "about_menu") {
        const content = "🌟 <b>درباره RBI24</b>\n\n" +
          "سیستم آموزشی RBI24 یک ساختار سازمانی چندلایه است که هدف آن:\n" +
          "• استانداردسازی آموزش‌ها\n" +
          "• کاهش خطای انسانی\n" +
          "• رشد مرحله‌به‌مرحله افراد\n\n" +
          "می‌باشد.";
        
        await editMessageText(chatId, callback.message.message_id, 
          formatMessage("درباره ما", content), 
          { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "back_to_main" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await logUserAction(userId, "viewed_about");
        return;
      }

      // --- SUPPORT MENU ---
      if (cd === "support_menu") {
        await editMessageText(chatId, callback.message.message_id, 
          formatMessage("سیستم پشتیبانی RBI24", "ما همیشه کنار شما هستیم 💙\n\nیکی از گزینه‌های زیر را انتخاب کنید:"), 
          supportMenuKeyboard()
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await logUserAction(userId, "opened_support");
        return;
      }

      // --- SUPPORT EMAIL ---
      if (cd === "support_email") {
        await editMessageText(chatId, callback.message.message_id, 
          formatMessage("پشتیبانی ایمیلی", "📧 لطفاً با ایمیل زیر تماس بگیرید:\n\n<b>support@rbi24.com</b>"), 
          { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "support_menu" }]] }
        );
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      // --- SUPPORT TICKET ---
      if (cd === "support_ticket") {
        const canSend = await canSendTicket(userId);
        
        if (!canSend) {
          await answerCallbackQuery(callback.id, "⚠️ شما حداکثر 3 تیکت در 24 ساعه می‌توانید ارسال کنید.");
          return;
        }
        
        const userRec = await getUserById(userId);
        await deleteMenuIfExists(userId, chatId);
        
        if (userRec && userRec.email && userRec.emailConfirmed === "Yes") {
          await setUserStateFields(userId, { step: "awaiting_ticket_message", tempData: userRec.email });
          const kb = { inline_keyboard: [[{ text: "↩️ لغو", callback_data: "back_to_main_send" }]] };
          await sendMessage(chatId, 
            formatMessage("ارسال تیکت", "🎫 لطفاً پیام تیکت خود را وارد کنید:\n\n(ایمیل ثبت‌شده شما به‌صورت خودکار ضمیمه می‌شود)"), 
            kb
          );
        } else {
          await setUserStateFields(userId, { step: "awaiting_ticket_email_1", tempData: "" });
          const kb = { inline_keyboard: [[{ text: "↩️ لغو", callback_data: "back_to_main_send" }]] };
          await sendMessage(chatId, 
            formatMessage("ارسال تیکت", "📧 لطفاً ایمیل خود را وارد کنید:\n(مثال: example@domain.com)"), 
            kb
          );
        }
        
        await logUserAction(userId, "started_ticket");
        return;
      }

      return;
    }

    // ========================================
    // TEXT MESSAGE HANDLERS
    // ========================================
    
    const state = await getUserState(userId);
    const step = state.step || "";

    // --- ADMIN COMMANDS (text-based) ---
    if (String(userId) === String(ADMIN_CHAT_ID) && text === "/admin") {
      await deleteMenuIfExists(userId, chatId);
      const mid = await sendMessage(chatId, 
        formatMessage("پنل ادمین", "به پنل مدیریت ربات خوش آمدید 🔐"), 
        adminMenuKeyboard()
      );
      if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
      return;
    }

    // --- ADMIN: Broadcast message ---
    if (String(userId) === String(ADMIN_CHAT_ID) && step === "awaiting_broadcast_message" && text) {
      await handleBroadcast(chatId, text);
      await clearUserState(userId);
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
    let content = "";
    let count = 0;

    for (let i = 1; i < tickets.length; i++) {
      const row = tickets[i];
      if (!(row[4] || "").trim()) {
        const tid = row[0] || "";
        const uid = row[1] || "";
        const email = row[2] || "";
        const msg = (row[3] || "").substring(0, 80);
        const date = row[5] || "";

        content += `🔖 <code>${tid}</code>\n👤 ${uid} | ${email}\n📝 ${msg}...\n🗓 ${date}\n\n`;
        count++;
        if (count >= 5) break;
      }
    }

    if (!content) {
      content = "✅ در حال حاضر تیکت باز وجود ندارد.";
    } else {
      content = `<b>${count} تیکت باز:</b>\n\n` + content +
        `برای پاسخ:\n<code>/reply_TICKET_ID</code>`;
    }

    await editMessageText(chatId, messageId,
      formatMessage("تیکت‌های باز", content),
      { inline_keyboard: [[{ text: "↩️ بستن", callback_data: "admin_close" }]] }
    );
  } catch (e) {
    console.error("handleAdminViewTickets error:", e.message);
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



    
