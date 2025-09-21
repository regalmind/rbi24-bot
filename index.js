// index.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json());

// ---- Configuration from environment variables ----
const BOT_TOKEN = process.env.BOT_TOKEN; // set in Cloud Run
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; // set in Cloud Run
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || ""; // set in Cloud Run
const PORT = process.env.PORT || 8080;

if (!BOT_TOKEN || !SPREADSHEET_ID) {
  console.error("BOT_TOKEN and SPREADSHEET_ID must be set as environment variables");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ---- Google Sheets auth using service account ----
// expects GOOGLE_SERVICE_ACCOUNT_KEY JSON string in env (or use GOOGLE_APPLICATION_CREDENTIALS on Cloud Run)
let sheetsClient;
async function initSheetsClient() {
  // If a raw JSON key is present in env var, use it; else rely on default ADC (Cloud Run service account)
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
}

// ---- Helpers for Telegram ----
async function telegramCall(method, payload) {
  try {
    const res = await axios.post(`${TELEGRAM_API}/${method}`, payload, { timeout: 15000 });
    return res.data;
  } catch (err) {
    console.error('telegramCall error', err?.response?.data || err.message);
    // notify admin
    try { await sendMessage(ADMIN_CHAT_ID, `⚠️ telegramCall error: ${JSON.stringify(err?.response?.data || err.message)}`); } catch(e){}
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
  return telegramCall('editMessageText', { chat_id: String(chatId), message_id: Number(messageId), text, parse_mode: 'HTML', reply_markup });
}

async function answerCallbackQuery(callbackQueryId, text) {
  return telegramCall('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// ---- Sheets utilities ----
async function ensureSheetHeaders() {
  const sheets = sheetsClient;
  const meta = [
    { name: "Users", headers: ["UserID", "Username", "FirstName", "LastName", "Email", "JoinedAt"] },
    { name: "State", headers: ["UserID", "Step", "TempData", "LastMenu", "TempEmail"] },
    { name: "Tickets", headers: ["TicketID", "UserID", "Email", "Message", "Answer", "CreatedAt", "AnsweredAt", "Notified"] },
    { name: "EmailLog", headers: ["UserID", "Email", "Count", "LastSentAt"] },
    { name: "InvestRequests", headers: ["RequestID", "UserID", "FullName", "Email", "TxHash", "Duration", "Amount", "Status", "Notified", "CreatedAt"] },
    { name: "WithdrawRequests", headers: ["RequestID", "UserID", "FullName", "Email", "WalletAddress", "Amount", "Status", "Notified", "CreatedAt"] },
    { name: "BroadcastLogs", headers: ["BroadcastID", "UserID", "MessageID", "SentAt", "DeletedFlag"] }
  ];

  // read spreadsheet to find existing sheets
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = spreadsheet.data.sheets.map(s => s.properties.title);

  for (const s of meta) {
    if (!existing.includes(s.name)) {
      // create sheet
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: s.name } } }]
        }
      });
      // set headers
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${s.name}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [s.headers] }
      });
    } else {
      // ensure headers exist (simple: set headers to first row)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${s.name}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [s.headers] }
      });
    }
  }
}

// helper: append row
async function appendRow(sheetName, rowValues) {
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:A`,
    valueInputOption: "RAW",
    requestBody: { values: [rowValues] }
  });
}

// helper: read all
async function readSheet(sheetName) {
  const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}` });
  return res.data.values || [];
}

// helper find row by first col value (returns 0-based index in data)
function findIndexByFirstCol(data, val) {
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(val)) return i;
  }
  return -1;
}

// update a row by row number (1-based)
async function updateRow(sheetName, rowNumber, rowValues) {
  const range = `${sheetName}!A${rowNumber}:Z${rowNumber}`;
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [rowValues] }
  });
}

// get user from Users by ID
async function getUserById(userId) {
  const data = await readSheet("Users");
  const idx = findIndexByFirstCol(data, userId);
  if (idx === -1) return null;
  const row = data[idx]; // row is array
  return { userId: row[0], username: row[1], firstName: row[2], lastName: row[3], email: row[4], rowIndex: idx + 1 };
}

// register or update user
async function registerOrUpdateUser(userId, firstName, lastName, username, email) {
  const data = await readSheet("Users");
  const idx = findIndexByFirstCol(data, userId);
  const now = new Date().toISOString();
  if (idx > -1) {
    const row = data[idx];
    // update columns 2..5
    row[1] = username || row[1] || "";
    row[2] = firstName || row[2] || "";
    row[3] = lastName || row[3] || "";
    if (email) row[4] = email;
    await updateRow("Users", idx + 1, row);
  } else {
    await appendRow("Users", [userId, username || "", firstName || "", lastName || "", email || "", now]);
  }
}

// get & set user state in State sheet
async function setUserState(userId, step, tempData, lastMenu, tempEmail) {
  const data = await readSheet("State");
  const idx = findIndexByFirstCol(data, userId);
  if (idx > -1) {
    const row = data[idx];
    row[1] = step || "";
    row[2] = tempData || "";
    row[3] = lastMenu || "";
    row[4] = tempEmail || "";
    await updateRow("State", idx + 1, row);
  } else {
    await appendRow("State", [userId, step || "", tempData || "", lastMenu || "", tempEmail || ""]);
  }
}

async function getUserState(userId) {
  const data = await readSheet("State");
  const idx = findIndexByFirstCol(data, userId);
  if (idx > -1) {
    const row = data[idx];
    return { step: row[1] || "", tempData: row[2] || "", lastMenu: row[3] || "", tempEmail: row[4] || "" };
  }
  return { step: "", tempData: "", lastMenu: "", tempEmail: "" };
}

async function clearUserState(userId) {
  const data = await readSheet("State");
  const idx = findIndexByFirstCol(data, userId);
  if (idx > -1) {
    await updateRow("State", idx + 1, [userId, "", "", "", ""]);
  }
}

// canSendEmail (simple)
async function canSendEmailToUser(userId, email) {
  const data = await readSheet("EmailLog");
  const idx = findIndexByFirstCol(data, userId);
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24*60*60*1000);
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
  // Cloud Run cannot directly use MailApp — need external SMTP or transactional email.
  // For now we'll notify admin and skip actual email sending — or you can integrate SendGrid/SMTP.
  // We'll just log and notify admin.
  console.log(`sendEmailSafe -> to:${to}, subject:${subject}`);
  try {
    await sendMessage(ADMIN_CHAT_ID, `📧 (pretend) sendEmail to ${to} subject:${subject}`);
    return true;
  } catch (e) {
    console.error("sendEmailSafe failed", e);
    return false;
  }
}

// ---- Formatting & Keyboards ----
function formatMessage(title, content, footer) {
  let msg = `🌟 <b>${title}</b> 🌟\n━━━━━━━━━━━━━━━\n${content}`;
  if (footer) msg += `\n━━━━━━━━━━━━━━━\n${footer}`;
  return msg;
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📚 آموزش‌ها ✨", callback_data: "edu_menu" }],
      [{ text: "🛟 سیستم پشتیبانی 🌟", callback_data: "support_menu" }],
      [{ text: "ℹ️ درباره‌ی ما 🔍", callback_data: "about_menu" }]
    ]
  };
}

function supportMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📧 پشتیبانی از طریق ایمیل", callback_data: "support_email" }],
      [{ text: "💬 چت آنلاین (AI)", callback_data: "support_chat_ai" }],
      [{ text: "🎫 ارسال تیکت", callback_data: "support_ticket" }],
      [{ text: "💼 ثبت درخواست سرمایه‌گذاری", callback_data: "support_invest" }],
      [{ text: "💸 برداشت سود و کمیسیون", callback_data: "support_withdraw" }],
      [{ text: "❓ سوالات متداول", callback_data: "support_faq" }],
      [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main" }]
    ]
  };
}

// ---- Business logic: handle updates ----
async function handleUpdate(update) {
  try {
    const message = update.message;
    const callback = update.callback_query;
    if (!message && !callback) return;

    let chatId, text = "", from;
    if (message) {
      chatId = message.chat.id;
      text = (message.text || "").toString();
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

    await registerOrUpdateUser(userId, firstName, lastName, username, null);

    // ---- handle callbacks ----
    if (callback) {
      await answerCallbackQuery(callback.id);
      const cd = callback.data;

      // BACK: حذف منوی قبلی (اگر وجود داشت) ولی پیام جاری را حذف نکن و منوی اصلی را به صورت NEW ارسال کن
      if (cd === "back_to_main") {
        await deleteMenuIfExists(userId, chatId, callback.message.message_id); // حذف منوی قبلی (نه پیام جاری)
        const mid = await sendMessage(chatId, formatMessage("خوش آمدید به ربات پارسی زبان RBI24", "لطفاً یکی از گزینه‌ها را انتخاب کنید:"), mainMenuKeyboard());
        if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
        await setUserState(userId, "", "main_shown", "");
        return;
      }

      // BACK: ارسال منوی اصلی به صورت NEW (برای حالت‌هایی که می‌خواهیم تاریخچه بماند)
      if (cd === "back_to_main_send") {
        await deleteMenuIfExists(userId, chatId);
        const mid = await sendMessage(chatId, formatMessage("خوش آمدید به ربات RBI24", "لطفاً یکی از گزینه‌ها را انتخاب کنید:"), mainMenuKeyboard());
        if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
        await setUserState(userId, "", "main_shown", "");
        return;
      }

      // آموزش‌ها / درباره‌ی ما -> ویرایش پیام منو (این پیام ها منو هستند)
      if (cd === "edu_menu" || cd === "about_menu") {
        const title = cd === "edu_menu" ? "آموزش‌ها" : "درباره‌ی ما";
        const content = "محتواهای این بخش در حال آماده سازی میباشد.\nاز صبر و شکیبایی شما متشکریم - تیم پشتیبانی RBI24";
        const kb = { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main" }]] };
        await editMessageText(chatId, callback.message.message_id, formatMessage(title, content), kb);
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await setUserState(userId, "", `${cd}_shown`, "");
        return;
      }

      // Support main menu -> این پیام منو است (ثبت می‌شود)
      if (cd === "support_menu") {
        await editMessageText(chatId, callback.message.message_id, formatMessage("سیستم پشتیبانی RBI24", "ما همیشه کنار شما هستیم. یکی از گزینه‌ها را انتخاب کنید:"), supportMenuKeyboard());
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await setUserState(userId, "", "support_menu", "");
        return;
      }

      // چت آنلاین -> حذف منوی قبلی و ارسال پیام جدید (تاریخچه نگه داشته شود)
      if (cd === "support_chat_ai") {
        await deleteMenuIfExists(userId, chatId);
        const kb = { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main_send" }]] };
        const mid = await sendMessage(chatId, formatMessage("چت آنلاین (AI)", "هوش مصنوعی و چت‌بات سیستم در حال برنامه‌نویسی و آماده‌سازی می‌باشد؛ از شکیبایی شما سپاس‌گزاریم.\n\nتیم پشتیبانی RBI24"), kb);
        // این پیام یک منوی پایدار نیست (ما آن را به عنوان lastMenu ثبت نمی‌کنیم) — تا با زدن بازگشت پاک نشود
        return;
      }

      // ارسال تیکت -> حذف منوی قبلی، باز کردن پیام جدید برای دریافت پیام تیکت (اگر ایمیل ثبت شده باشد از آن استفاده کن)
      if (cd === "support_ticket") {
        const userRec = await getUserById(userId);
        await deleteMenuIfExists(userId, chatId); // حذف منوی 7 دکمه‌ای قبلی
        if (userRec && userRec.email) {
          await setUserStateFields(userId, { step: "awaiting_ticket_message", tempData: userRec.email });
          const kb = { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main_send" }]] };
          await sendMessage(chatId, formatMessage("ارسال تیکت", "📧 لطفاً پیام تیکت خود را اینجا وارد نمایید. (ایمیل ثبت‌شده شما به‌صورت خودکار همراه تیکت ارسال خواهد شد)"), kb);
        } else {
          await setUserStateFields(userId, { step: "awaiting_ticket_email", tempData: "" });
          const kb = { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main_send" }]] };
          await sendMessage(chatId, formatMessage("ارسال تیکت", "📧 لطفاً ایمیل خود را وارد کنید (مثل example@domain.com):"), kb);
        }
        return;
      }

      // درخواست سرمایه گذاری -> این پیام منو است (ویرایش می‌شود) — آدرس ولت و هشدار اضافه شد
      if (cd === "support_invest") {
        const walletAddr = "0x88BB835838980abe796a9D3312123aaC22EFDfDc";
        const text = `لطفا مبلغ مد نظر جهت سرمایه‌گذاری را به صورت ارز USDT از طریق شبکه BEP20 به آدرس ولت زیر انتقال دهید و سپس دکمه "مورد تایید است" را فشار دهید.\n\nآدرس ولت: <code>${walletAddr}</code>\n\nتوجه: در صورت ارسال اشتباه در شبکه‌ای غیر از BEP20، سرمایه شما از بین خواهد رفت و مسئولیت تراکنش نادرست بر عهدهٔ شماست.`;
        await editMessageText(chatId, callback.message.message_id, formatMessage("درخواست سرمایه‌گذاری", text), { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main" }], [{ text: "مورد تایید است", callback_data: "invest_done" }]] });
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await setUserState(userId, "", "support_invest", "");
        return;
      }

      // وقتی کاربر "مورد تایید است" را زد -> پیام جدید برای وارد کردن نام ارسال کن
      if (cd === "invest_done") {
        await deleteMenuIfExists(userId, chatId);
        await setUserStateFields(userId, { step: "awaiting_invest_fullname", tempData: "" });
        await sendMessage(chatId, formatMessage("ثبت سرمایه‌گذاری", "لطفا نام و نام خانوادگی خود را کامل وارد نمایید:"));
        return;
      }

      // برداشت -> متن و دکمه تغییر کرد (مورد تایید است)
      if (cd === "support_withdraw") {
        const text = `در صورت اگاهی از قوانین و شرایط برداشت وجه دکمه "مورد تایید است" را فشار دهید و در غیر این صورت به بخش سوالات متداول یا درباره ما رجوع کنید`;
        await editMessageText(chatId, callback.message.message_id, formatMessage("برداشت سود و کمیسیون", text), { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main" }], [{ text: "مورد تایید است", callback_data: "withdraw_start" }]] });
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        await setUserState(userId, "", "support_withdraw", "");
        return;
      }

      if (cd === "withdraw_start") {
        await deleteMenuIfExists(userId, chatId);
        await setUserStateFields(userId, { step: "awaiting_withdraw_fullname", tempData: "" });
        await sendMessage(chatId, formatMessage("درخواست برداشت", "لطفا نام و نام خانوادگی خود را به صورت کامل وارد نمایید:"));
        return;
      }

      // ایمیل پشتیبانی / FAQ (ویرایش پیام منو)
      if (cd === "support_email") {
        await editMessageText(chatId, callback.message.message_id, formatMessage("پشتیبانی ایمیلی", "📧 لطفاً با ایمیل <b>support@rbi24.com</b> تماس بگیرید."), { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "back_to_support" }]] });
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      if (cd === "support_faq") {
        await editMessageText(chatId, callback.message.message_id, formatMessage("پرسش‌های متداول", "محتوا های این منو در حال آماده سازی میباشد، از شکیبایی شما نهایت قدردانی را داریم _ تیم پشتیبانی صندوق سرمایه گذاری RBI"), { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "back_to_support" }]] });
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      if (cd === "back_to_support") {
        await editMessageText(chatId, callback.message.message_id, formatMessage("سیستم پشتیبانی RBI24", "ما همیشه کنار شما هستیم. یکی از گزینه‌ها را انتخاب کنید:"), supportMenuKeyboard());
        await setUserStateFields(userId, { lastMenu: String(callback.message.message_id) });
        return;
      }

      return;
    }

    // ---- Normal text handling (non-callback) ----
    const state = await getUserState(userId);
    const step = state.step || "";

    // /start : پاک کردن منوهای قبلی و ارسال منوی اصلی جدید
    if (text && text.trim() === "/start") {
      await deleteMenuIfExists(userId, chatId);
      const mid = await sendMessage(chatId, formatMessage("خوش آمدید به ربات RBI24", "لطفاً یکی از گزینه‌های زیر را انتخاب کنید:"), mainMenuKeyboard());
      if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
      const user = await getUserById(userId);
      if (user && user.email) {
        await setUserState(userId, "", "main_shown", "");
      } else {
        await setUserStateFields(userId, { step: "awaiting_email" });
      }
      return;
    }

    // ثبت ایمیل اولیه
    if (step === "awaiting_email" && text) {
      const email = text.trim();
      if (!email.includes("@") || !email.includes(".")) {
        await sendMessage(chatId, formatMessage("ایمیل نامعتبر", "📧 لطفاً یک ایمیل معتبر وارد کنید (مثل example@domain.com):"));
        return;
      }
      const users = await readSheet("Users");
      const exists = users.find((r, i) => i>0 && String(r[4] || "").toLowerCase() === email.toLowerCase() && String(r[0]) !== String(userId));
      if (exists) {
        await sendMessage(chatId, formatMessage("ایمیل تکراری", "📧 این ایمیل قبلاً توسط کاربر دیگری ثبت شده است."));
        return;
      }
      await registerOrUpdateUser(userId, firstName, lastName, username, email);
      if (await canSendEmailToUser(userId, email)) {
        await sendEmailSafe(email, "Welcome to RBI24 Bot!", `<p>Dear ${firstName},</p><p>Welcome to RBI24 Bot!</p>`);
      }
      await deleteMenuIfExists(userId, chatId);
      const mid = await sendMessage(chatId, formatMessage("ثبت شد", "ایمیل شما با موفقیت ثبت شد. حالا می‌توانید از منوها استفاده کنید."), mainMenuKeyboard());
      if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
      await setUserState(userId, "", "main_shown", "");
      return;
    }

    // تیکت: اگر ایمیل پرسیده شده بود -> بعد پیام تیکت، ثبت در شیت
    if (step === "awaiting_ticket_email" && text) {
      const email = text.trim();
      if (!email.includes("@") || !email.includes(".")) {
        await sendMessage(chatId, formatMessage("ایمیل نامعتبر", "📧 لطفاً یک ایمیل معتبر وارد کنید (مثل example@domain.com):"));
        return;
      }
      await setUserStateFields(userId, { step: "awaiting_ticket_message", tempData: email });
      await deleteMenuIfExists(userId, chatId);
      await sendMessage(chatId, formatMessage("پیام تیکت", "🎫 لطفا پیام خود را وارد کنید:"));
      return;
    } else if (step === "awaiting_ticket_message" && text) {
      const email = state.tempData || "";
      const tid = `TICKET_${Date.now()}_${Math.floor(Math.random()*10000)}`;
      const createdAt = getNow();
      await appendRow("Tickets", [tid, userId, email, text, "", createdAt, ""]);
      await clearUserState(userId);
      // ارسال پیام تایید و دکمه بازگشت (این پیام منو ثبت نمیشود تا با زدن بازگشت منوی قبلی پاک نشود)
      await deleteMenuIfExists(userId, chatId);
      await sendMessage(chatId, formatMessage("تیکت ثبت شد", "✅ تیکت شما با موفقیت ثبت شد! تیم پشتیبانی به زودی پاسخ شما را خواهد داد."), { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main_send" }]] });
      // اطلاع ادمین
      await sendMessage(ADMIN_CHAT_ID, `📢 تیکت جدید!\nکاربر: ${firstName} (@${username || "ندارد"})\nایمیل: ${email}\nمتن: ${text}`);
      if (await canSendEmailToUser(userId, email)) {
        await sendEmailSafe(email, "RBI24 Support Ticket Received", `<p>Dear ${firstName},</p><p>Your ticket has been received. We will contact you soon.</p>`);
      }
      return;
    }

    // سرمایه گذاری - جریان چندمرحله‌ای
    if (step === "awaiting_invest_fullname" && text) {
      const fullName = text.trim();
      if (!fullName) {
        await sendMessage(chatId, formatMessage("نام نامعتبر", "لطفا نام و نام خانوادگی خود را به درستی وارد نمایید."));
        return;
      }
      await setUserStateFields(userId, { step: "awaiting_invest_tx", tempData: fullName });
      await deleteMenuIfExists(userId, chatId);
      await sendMessage(chatId, formatMessage("ثبت سرمایه‌گذاری", "لطفا تراکنش (TxHash) واریزی خود را وارد نمایید سپس کلید تایید را بفشارید."));
      return;
    } else if (step === "awaiting_invest_tx" && text) {
      const tx = text.trim();
      const prev = state.tempData || "";
      const fullName = prev;
      await setUserStateFields(userId, { step: "awaiting_invest_duration", tempData: `${fullName}||${tx}` });
      await deleteMenuIfExists(userId, chatId);
      await sendMessage(chatId, formatMessage("ثبت سرمایه‌گذاری", "لطفا مدت زمان مد نظر برای قرارداد خود را وارد نمایید سپس کلید تایید را بفشارید."));
      return;
    } else if (step === "awaiting_invest_duration" && text) {
      const duration = text.trim();
      const prev = state.tempData || "";
      const parts = prev.split("||");
      const fullName = parts[0] || "";
      const tx = parts[1] || "";
      await setUserStateFields(userId, { step: "awaiting_invest_amount", tempData: `${fullName}||${tx}||${duration}` });
      await deleteMenuIfExists(userId, chatId);
      await sendMessage(chatId, formatMessage("ثبت سرمایه‌گذاری", "لطفا مبلغ واریزی خود را وارد نمایید سپس کلید تایید را بفشارید.\n(توجه: لطفاً فقط عدد را با ارقام لاتین وارد کنید)"));
      return;
    } else if (step === "awaiting_invest_amount" && text) {
      const amount = text.trim();
      const parts = (state.tempData || "").split("||");
      const fullName = parts[0] || "";
      const tx = parts[1] || "";
      const duration = parts[2] || "";
      const reqId = `INV_${Date.now()}_${Math.floor(Math.random()*10000)}`;
      const createdAt = getNow();
      // get user's email and save it in row (Email column after FullName)
      const userRec = await getUserById(userId);
      const email = (userRec && userRec.email) ? userRec.email : "";
      // InvestRequests header must include Email column at index after FullName
      await appendRow("InvestRequests", [reqId, userId, fullName, email, tx, duration, amount, "Pending", "No", createdAt]);
      await clearUserState(userId);
      await deleteMenuIfExists(userId, chatId);
      await sendMessage(chatId, formatMessage("درخواست ثبت شد", "✅ اطلاعات ثبت شد. کارشناسان ما بعد از بررسی نتیجه را به شما اطلاع میدهند."), { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main_send" }]] });
      await sendMessage(ADMIN_CHAT_ID, `📢 درخواست سرمایه‌گذاری جدید\nکاربر: ${fullName} (ID: ${userId})\nایمیل: ${email}\nمبلغ: ${amount}\nduration: ${duration}\ntx: ${tx}\nRequestID: ${reqId}`);
      return;
    }

    // برداشت چندمرحله‌ای
    if (step === "awaiting_withdraw_fullname" && text) {
      const fn = text.trim();
      await setUserStateFields(userId, { step: "awaiting_withdraw_wallet", tempData: fn });
      await deleteMenuIfExists(userId, chatId);
      await sendMessage(chatId, formatMessage("درخواست برداشت", "📌 لطفا آدرس ولت USDT شبکه BEP20 را وارد نمایید.\n\nتوجه بسیار مهم: حتماً آدرس را در شبکه BEP20 وارد کنید. در صورت ارسال آدرس اشتباه یا ارسال در شبکه‌ای غیر از BEP20، سرمایه شما از بین خواهد رفت و مسئولیت تراکنش نادرست بر عهدهٔ شما می‌باشد. لطفاً آدرس را با دقت وارد کنید."));
      return;
    } else if (step === "awaiting_withdraw_wallet" && text) {
      const wallet = text.trim();
      const prev = state.tempData || "";
      await setUserStateFields(userId, { step: "awaiting_withdraw_amount", tempData: `${prev}||${wallet}` });
      await deleteMenuIfExists(userId, chatId);
      await sendMessage(chatId, formatMessage("درخواست برداشت", "لطفا مبلغ مورد نظر جهت برداشت را به اعداد لاتین وارد نمایید."));
      return;
    } else if (step === "awaiting_withdraw_amount" && text) {
      const amount = text.trim();
      const parts = (state.tempData || "").split("||");
      const fullName = parts[0] || "";
      const wallet = parts[1] || "";
      const reqId = `WDR_${Date.now()}_${Math.floor(Math.random()*10000)}`;
      const createdAt = getNow();
      const userRec = await getUserById(userId);
      const email = (userRec && userRec.email) ? userRec.email : "";
      // WithdrawRequests header must include Email column after FullName
      await appendRow("WithdrawRequests", [reqId, userId, fullName, email, wallet, amount, "Pending", "No", createdAt]);
      await clearUserState(userId);
      await deleteMenuIfExists(userId, chatId);
      await sendMessage(chatId, formatMessage("درخواست ثبت شد", "✅ درخواست برداشت شما با موفقیت ثبت شد. کارشناسان ما پس از بررسی اطلاع‌رسانی می‌کنند."), { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "back_to_main_send" }]] });
      await sendMessage(ADMIN_CHAT_ID, `📢 درخواست برداشت جدید\nکاربر: ${fullName} (ID: ${userId})\nایمیل: ${email}\nwallet: ${wallet}\namount: ${amount}\nRequestID: ${reqId}`);
      return;
    }

    // default: متن عادی و منوی اصلی را ارسال کن (پاک کردن منوهای قبلی)
    if (text && !step) {
      await deleteMenuIfExists(userId, chatId);
      const mid = await sendMessage(chatId, formatMessage("خوش آمدید به ربات RBI24", "لطفاً یکی از گزینه‌های زیر را انتخاب کنید:"), mainMenuKeyboard());
      if (mid) await setUserStateFields(userId, { lastMenu: String(mid) });
      return;
    }

  } catch (err) {
    console.error("handleUpdate error", err);
    try { await sendMessage(ADMIN_CHAT_ID, `⚠️ handleUpdate error: ${String(err)}`); } catch(e){}
  }
}

// ---- Webhook endpoint ----
app.post('/webhook', async (req, res) => {
  const update = req.body;
  // respond early to Telegram
  res.status(200).send('ok');
  // process async
  try {
    await handleUpdate(update);
  } catch (e) {
    console.error('processing update failed', e);
  }
});

app.get('/', (req, res) => res.send('RBI24 Bot running'));

// ----------------- Helpers for State & Menu management -----------------

// get current time string (Tehran) for human readable timestamp
function getNow() {
  try {
    // format: YYYY-MM-DD HH:MM:SS (tehran time)
    return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tehran' }).replace('T', ' ');
  } catch (e) {
    return new Date().toISOString();
  }
}

// setUserStateFields: update specific named fields for user's State row.
// fields: { step, tempData, lastMenu, tempEmail } - any subset allowed.
async function setUserStateFields(userId, fields) {
  const data = await readSheet("State");
  let idx = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(userId)) { idx = i; break; }
  }
  if (idx === -1) {
    // append new row with columns A:UserID, B:Step, C:TempData, D:LastMenu, E:TempEmail
    const row = [userId,
      fields.step || "",
      fields.tempData || "",
      fields.lastMenu || "",
      fields.tempEmail || ""
    ];
    await appendRow("State", row);
  } else {
    const row = data[idx];
    // ensure length at least 5
    while (row.length < 5) row.push("");
    if (fields.step !== undefined) row[1] = fields.step;
    if (fields.tempData !== undefined) row[2] = fields.tempData;
    if (fields.lastMenu !== undefined) row[3] = fields.lastMenu;
    if (fields.tempEmail !== undefined) row[4] = fields.tempEmail;
    await updateRow("State", idx + 1, row);
  }
}

// backward-compatible wrapper: original code calls setUserState(userId, step, tempData, lastMenu, tempEmail)
async function setUserState(userId, step = "", tempData = "", lastMenu = "", tempEmail = "") {
  await setUserStateFields(userId, { step, tempData, lastMenu, tempEmail });
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

// delete the previously recorded menu message (if exists) — used to keep chat clean.
// exceptMessageId: if provided, won't delete that message (useful when editing that message)
async function deleteMenuIfExists(userId, chatId, exceptMessageId = null) {
  try {
    const s = await getUserState(userId);
    const last = s.lastMenu;
    if (last && String(last) !== String(exceptMessageId)) {
      // try delete
      try {
        await telegramCall('deleteMessage', { chat_id: String(chatId), message_id: Number(last) });
      } catch (e) {
        // ignore if can't delete (maybe already deleted)
      }
      // clear lastMenu in state
      await setUserStateFields(userId, { lastMenu: "" });
    }
  } catch (e) { console.error("deleteMenuIfExists error", e); }
}

// record a message id as the "current menu" for the user
async function recordMenuMessage(userId, chatId, messageId) {
  // delete existing menu if different
  await deleteMenuIfExists(userId, chatId, messageId);
  await setUserStateFields(userId, { lastMenu: String(messageId) });
}

// ----------------- Admin sync endpoint -----------------
// Protect this route with a secret token (set ENV: ADMIN_SYNC_SECRET)
app.get('/admin/sync', async (req, res) => {
  const secret = req.query.secret || "";
  if (!process.env.ADMIN_SYNC_SECRET || secret !== process.env.ADMIN_SYNC_SECRET) {
    return res.status(403).send('Forbidden');
  }
  try {
    // ----- Tickets -----
    const tickets = await readSheet("Tickets");
    // headers: ["TicketID","UserID","Email","Message","Answer","CreatedAt","AnsweredAt","Notified"]
    for (let i = 1; i < tickets.length; i++) {
      const row = tickets[i];
      const ticketId = row[0];
      const userId = row[1];
      const email = row[2] || "";
      const message = row[3] || "";
      const answer = row[4] || "";
      const createdAt = row[5] || "";
      const answeredAt = row[6] || "";
      const notified = (row[7] || "").toString().toLowerCase();

      if (answer && notified !== 'yes') {
        // send answer to user with new phrasing
        const text = `📢 پاسخ تیکت ارسالی شما به شماره ${ticketId}\nبه شرح ذیل می‌باشد:\n\n${answer}`;
        try {
          await sendMessage(userId, text);
        } catch (e) { console.error("send ticket answer failed", e); }
        const now = getNow();
        // update AnsweredAt and Notified
        await updateRow("Tickets", i + 1, [ticketId, userId, email, message, answer, createdAt || "", now, "Yes"]);
      }
    }

    // ----- InvestRequests -----
    const invests = await readSheet("InvestRequests");
    // headers: ["RequestID","UserID","FullName","Email","TxHash","Duration","Amount","Status","Notified","CreatedAt"]
    for (let i = 1; i < invests.length; i++) {
      const row = invests[i];
      const reqId = row[0];
      const userId = row[1];
      const fullName = row[2] || "";
      const email = row[3] || "";
      const tx = row[4] || "";
      const duration = row[5] || "";
      const amount = row[6] || "";
      const status = (row[7] || "Pending").trim();
      const notified = (row[8] || "").toString().toLowerCase();
      const createdAt = row[9] || "";

      if (status !== "Pending" && notified !== "yes") {
        let text = "";
        if (status === "Accepted") text = `✅ درخواست سرمایه‌گذاری شما (${reqId}) تایید شد.\nمبلغ: ${amount}\nمدت: ${duration}\nبا تشکر.`;
        else if (status === "Rejected") text = `❌ متاسفانه درخواست سرمایه‌گذاری شما (${reqId}) رد شد.\nبا پشتیبانی تماس بگیرید.`;
        else text = `✅درخواست شما توسط کارشناسان ما بررسی شد.\nشماره درخواست: ${reqId}\nنتیجه ی درخواست = ${status}`;
        try { await sendMessage(userId, text); } catch(e){ console.error("notify invest user failed", e); }
        // set Notified = Yes and keep CreatedAt
        await updateRow("InvestRequests", i + 1, [reqId, userId, fullName, email, tx, duration, amount, status, "Yes", createdAt || getNow()]);
      }
    }

    // ----- WithdrawRequests -----
    const wds = await readSheet("WithdrawRequests");
    // headers: ["RequestID","UserID","FullName","Email","WalletAddress","Amount","Status","Notified","CreatedAt"]
    for (let i = 1; i < wds.length; i++) {
      const row = wds[i];
      const reqId = row[0];
      const userId = row[1];
      const fullName = row[2] || "";
      const email = row[3] || "";
      const wallet = row[4] || "";
      const amount = row[5] || "";
      const status = (row[6] || "Pending").trim();
      const notified = (row[7] || "").toString().toLowerCase();
      const createdAt = row[8] || "";

      if (status !== "Pending" && notified !== "yes") {
        let text = "";
        if (status === "Accepted") text = `✅درخواست برداشت شما بررسی و پرداخت شد.\nشماره درخواست: ${reqId}\nنتیجه ی درخواست = ${status}\nمبلغ: ${amount}\nآدرس: ${wallet}`;
        else if (status === "Rejected") text = `❌ درخواست برداشت شما (${reqId}) رد شد. لطفاً با پشتیبانی تماس بگیرید.`;
        else text = `✅درخواست شما توسط کارشناسان ما بررسی شد.\nشماره درخواست: ${reqId}\nنتیجه ی درخواست = ${status}`;
        try { await sendMessage(userId, text); } catch (e) { console.error("notify withdraw user failed", e); }
        await updateRow("WithdrawRequests", i + 1, [reqId, userId, fullName, email, wallet, amount, status, "Yes", createdAt || getNow()]);
      }
    }

    res.send('Sync completed');
  } catch (e) {
    console.error("admin sync error", e);
    res.status(500).send('Error');
  }
});

async function main() {
  await initSheetsClient();
  await ensureSheetHeaders();
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

main().catch(err => {
  console.error('Fatal error during startup', err);
  process.exit(1);

});







