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
    { name: "Tickets", headers: ["TicketID", "UserID", "Email", "Message", "Answer", "CreatedAt", "AnsweredAt"] },
    { name: "EmailLog", headers: ["UserID", "Email", "Count", "LastSentAt"] },
    { name: "InvestRequests", headers: ["RequestID", "UserID", "FullName", "TxHash", "Duration", "Amount", "Status", "Notified", "CreatedAt"] },
    { name: "WithdrawRequests", headers: ["RequestID", "UserID", "FullName", "WalletAddress", "Amount", "Status", "Notified", "CreatedAt"] },
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

    // ensure basic user record
    const firstName = from?.first_name || "";
    const lastName = from?.last_name || "";
    const username = from?.username || "";
    const userId = chatId;

    await registerOrUpdateUser(userId, firstName, lastName, username, null);

    // handle callback
    if (callback) {
      await answerCallbackQuery(callback.id);
      const cd = callback.data;
      if (cd === "back_to_main") {
        await editMessageText(chatId, callback.message.message_id, formatMessage("خوش آمدید به ربات RBI24", "لطفاً یکی از گزینه‌ها را انتخاب کنید:", "💎 RBI24"), mainMenuKeyboard());
        await setUserState(userId, "", "", "");
        return;
      }
      if (cd === "support_menu") {
        await editMessageText(chatId, callback.message.message_id, formatMessage("سیستم پشتیبانی RBI24", "ما همیشه کنار شما هستیم. یکی از گزینه‌ها را انتخاب کنید:"), supportMenuKeyboard());
        await setUserState(userId, "", "support_menu", "");
        return;
      }
      if (cd === "support_chat_ai") {
        await sendMessage(chatId, formatMessage("چت آنلاین (AI)", "هوش مصنوعی و چت‌بات سیستم در حال برنامه‌نویسی و آماده‌سازی می‌باشد؛ از شکیبایی شما سپاس‌گزاریم.\n\nتیم پشتیبانی RBI24"));
        return;
      }
      if (cd === "support_ticket") {
        await setUserState(userId, "awaiting_ticket_email", "support_menu", "");
        await sendMessage(chatId, formatMessage("ارسال تیکت", "📧 لطفاً ایمیل خود را وارد کنید (مثل example@domain.com):"));
        return;
      }
      if (cd === "support_invest") {
        const kb = { inline_keyboard: [[{ text: "↩️ بازگشت به منوی قبل", callback_data: "back_to_support" }], [{ text: "✅ انجام شد", callback_data: "invest_done" }]] };
        await sendMessage(chatId, formatMessage("درخواست سرمایه‌گذاری", "لطفا مبلغ مد نظر جهت سرمایه‌گذاری را به صورت ارز USDT از طریق شبکه BEP20 به آدرس ولت زیر انتقال داده سپس گزینه [انجام شد] را فشار دهید.\n\nآدرس ولت: <code>YOUR_BEP20_WALLET_ADDRESS</code>"), kb);
        return;
      }
      if (cd === "invest_done") {
        await setUserState(userId, "awaiting_invest_fullname", "support_invest", "");
        await sendMessage(chatId, formatMessage("ثبت سرمایه‌گذاری", "لطفا نام و نام خانوادگی خود را کامل وارد نمایید:"));
        return;
      }
      if (cd === "support_withdraw") {
        const kb = { inline_keyboard: [[{ text: "↩️ بازگشت به منوی قبل", callback_data: "back_to_support" }], [{ text: "✅ انجام شد", callback_data: "withdraw_start" }]] };
        await sendMessage(chatId, formatMessage("برداشت سود و کمیسیون", "برای برداشت وجه، لطفاً شرایط را رعایت کرده و سپس دکمه انجام شد را فشار دهید."), kb);
        return;
      }
      if (cd === "withdraw_start") {
        await setUserState(userId, "awaiting_withdraw_fullname", "support_withdraw", "");
        await sendMessage(chatId, formatMessage("درخواست برداشت", "لطفا نام و نام خانوادگی خود را به صورت کامل وارد نمایید:"));
        return;
      }
      if (cd === "back_to_support") {
        await editMessageText(chatId, callback.message.message_id, formatMessage("سیستم پشتیبانی RBI24", "ما همیشه کنار شما هستیم. یکی از گزینه‌ها را انتخاب کنید:"), supportMenuKeyboard());
        await setUserState(userId, "", "support_menu", "");
        return;
      }
      if (cd === "support_email") {
        await sendMessage(chatId, formatMessage("پشتیبانی ایمیلی", "📧 لطفاً با ایمیل <b>support@rbi24.com</b> تماس بگیرید."), { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "back_to_support" }]] });
        return;
      }
      if (cd === "support_faq") {
        await sendMessage(chatId, formatMessage("پرسش‌های متداول", "محتوا های این منو در حال آماده سازی میباشد، از شکیبایی شما نهایت قدردانی را داریم _ تیم پشتیبانی صندوق سرمایه گذاری RBI"));
        return;
      }
      return;
    }

    // normal message handling
    // read state
    const state = await getUserState(userId);
    const step = state.step || "";

    // /start
    if (text && text.trim() === "/start") {
      const user = await getUserById(userId);
      if (user && user.email) {
        await sendMessage(chatId, formatMessage("خوش آمدید", "ایمیل شما قبلاً ثبت شده است. لطفاً یکی از گزینه‌های زیر را انتخاب کنید:"), mainMenuKeyboard());
        await setUserState(userId, "", "main_shown", "");
        return;
      } else {
        await setUserState(userId, "awaiting_email", "awaiting_email_shown", "");
        await sendMessage(chatId, formatMessage("خوش آمدید", "🌟 سلام! برای شروع، لطفاً ایمیل خودتون رو وارد کنید (مثل example@domain.com):"));
        return;
      }
    }

    // collect email
    if (step === "awaiting_email" && text) {
      const email = text.trim();
      if (!email.includes("@") || !email.includes(".")) {
        await sendMessage(chatId, formatMessage("ایمیل نامعتبر", "📧 لطفاً یک ایمیل معتبر وارد کنید (مثل example@domain.com):"));
        return;
      }
      // check uniqueness
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
      await sendMessage(chatId, formatMessage("ثبت شد", "ایمیل شما با موفقیت ثبت شد. حالا می‌توانید از منوها استفاده کنید."), mainMenuKeyboard());
      await setUserState(userId, "", "main_shown", "");
      return;
    }

    // ticket flow
    if (step === "awaiting_ticket_email" && text) {
      const email = text.trim();
      if (!email.includes("@") || !email.includes(".")) {
        await sendMessage(chatId, formatMessage("ایمیل نامعتبر", "📧 لطفاً یک ایمیل معتبر وارد کنید (مثل example@domain.com):"));
        return;
      }
      await setUserState(userId, "awaiting_ticket_message", "support_menu", email);
      await sendMessage(chatId, formatMessage("پیام تیکت", "🎫 لطفا پیام خود را وارد کنید:"));
      return;
    } else if (step === "awaiting_ticket_message" && text) {
      const email = state.tempData || "";
      const tid = `TICKET_${Date.now()}_${Math.floor(Math.random()*10000)}`;
      await appendRow("Tickets", [tid, userId, email, text, "", new Date().toISOString(), ""]);
      await clearUserState(userId);
      await sendMessage(chatId, formatMessage("تیکت ثبت شد", "✅ تیکت شما با موفقیت ثبت شد! تیم پشتیبانی به زودی پاسخ شما را خواهد داد."));
      await sendMessage(ADMIN_CHAT_ID, `📢 تیکت جدید!\nکاربر: ${firstName} (@${username || "ندارد"})\nایمیل: ${email}\nمتن: ${text}`);
      if (await canSendEmailToUser(userId, email)) {
        await sendEmailSafe(email, "RBI24 Support Ticket Received", `<p>Dear ${firstName},</p><p>Your ticket has been received. We will contact you soon.</p>`);
      }
      return;
    }

    // invest multi-step
    if (step === "awaiting_invest_fullname" && text) {
      const fullName = text.trim();
      if (!fullName) {
        await sendMessage(chatId, formatMessage("نام نامعتبر", "لطفا نام و نام خانوادگی خود را به درستی وارد نمایید."));
        return;
      }
      await setUserState(userId, "awaiting_invest_tx", "support_invest", fullName);
      await sendMessage(chatId, formatMessage("ثبت سرمایه‌گذاری", "لطفا تراکنش (TxHash) واریزی خود را وارد نمایید سپس کلید تایید را بفشارید."));
      return;
    } else if (step === "awaiting_invest_tx" && text) {
      const tx = text.trim();
      const prev = state.tempData || "";
      const fullName = prev;
      await setUserState(userId, "awaiting_invest_duration", "support_invest", `${fullName}||${tx}`);
      await sendMessage(chatId, formatMessage("ثبت سرمایه‌گذاری", "لطفا مدت زمان مد نظر برای قرارداد خود را وارد نمایید سپس کلید تایید را بفشارید."));
      return;
    } else if (step === "awaiting_invest_duration" && text) {
      const duration = text.trim();
      const prev = state.tempData || "";
      const parts = prev.split("||");
      const fullName = parts[0] || "";
      const tx = parts[1] || "";
      await setUserState(userId, "awaiting_invest_amount", "support_invest", `${fullName}||${tx}||${duration}`);
      await sendMessage(chatId, formatMessage("ثبت سرمایه‌گذاری", "لطفا مبلغ واریزی خود را وارد نمایید سپس کلید تایید را بفشارید."));
      return;
    } else if (step === "awaiting_invest_amount" && text) {
      const amount = text.trim();
      const parts = (state.tempData || "").split("||");
      const fullName = parts[0] || "";
      const tx = parts[1] || "";
      const duration = parts[2] || "";
      const reqId = `INV_${Date.now()}_${Math.floor(Math.random()*10000)}`;
      await appendRow("InvestRequests", [reqId, userId, fullName, tx, duration, amount, "Pending", "No", new Date().toISOString()]);
      await clearUserState(userId);
      await sendMessage(chatId, formatMessage("درخواست ثبت شد", "✅ اطلاعات ثبت شد. کارشناسان ما بعد از بررسی نتیجه را به شما اطلاع میدهند."));
      await sendMessage(ADMIN_CHAT_ID, `📢 درخواست سرمایه‌گذاری جدید\nکاربر: ${fullName} (ID: ${userId})\nمبلغ: ${amount}\nduration: ${duration}\ntx: ${tx}\nRequestID: ${reqId}`);
      const userRec = await getUserById(userId);
      if (userRec && userRec.email && await canSendEmailToUser(userId, userRec.email)) {
        await sendEmailSafe(userRec.email, "درخواست سرمایه‌گذاری شما ثبت شد", `<p>درخواست شما با شناسه <b>${reqId}</b> ثبت شد و در صف بررسی است.</p>`);
      }
      return;
    }

    // withdraw multi-step
    if (step === "awaiting_withdraw_fullname" && text) {
      const fn = text.trim();
      await setUserState(userId, "awaiting_withdraw_wallet", "support_withdraw", fn);
      await sendMessage(chatId, formatMessage("درخواست برداشت", "لطفا آدرس ولت USDT شبکه BEP20 را وارد نمایید."));
      return;
    } else if (step === "awaiting_withdraw_wallet" && text) {
      const wallet = text.trim();
      const prev = state.tempData || "";
      await setUserState(userId, "awaiting_withdraw_amount", "support_withdraw", `${prev}||${wallet}`);
      await sendMessage(chatId, formatMessage("درخواست برداشت", "لطفا مبلغ مورد نظر جهت برداشت را وارد نمایید."));
      return;
    } else if (step === "awaiting_withdraw_amount" && text) {
      const amount = text.trim();
      const parts = (state.tempData || "").split("||");
      const fullName = parts[0] || "";
      const wallet = parts[1] || "";
      const reqId = `WDR_${Date.now()}_${Math.floor(Math.random()*10000)}`;
      await appendRow("WithdrawRequests", [reqId, userId, fullName, wallet, amount, "Pending", "No", new Date().toISOString()]);
      await clearUserState(userId);
      await sendMessage(chatId, formatMessage("درخواست ثبت شد", "✅ درخواست برداشت شما با موفقیت ثبت شد. کارشناسان ما پس از بررسی اطلاع‌رسانی می‌کنند."));
      await sendMessage(ADMIN_CHAT_ID, `📢 درخواست برداشت جدید\nکاربر: ${fullName} (ID: ${userId})\nwallet: ${wallet}\namount: ${amount}\nRequestID: ${reqId}`);
      const userRec = await getUserById(userId);
      if (userRec && userRec.email && await canSendEmailToUser(userId, userRec.email)) {
        await sendEmailSafe(userRec.email, "درخواست برداشت شما ثبت شد", `<p>درخواست برداشت شما با شناسه <b>${reqId}</b> ثبت شد و در صف بررسی است.</p>`);
      }
      return;
    }

    // default: show menu
    if (text && !step) {
      const userRec = await getUserById(userId);
      if (userRec && userRec.email) {
        await sendMessage(chatId, formatMessage("خوش آمدید به ربات RBI24", "لطفاً یکی از گزینه‌های زیر را انتخاب کنید:"), mainMenuKeyboard());
        await setUserState(userId, "", "main_shown", "");
        return;
      } else {
        await setUserState(userId, "awaiting_email", "awaiting_email_shown", "");
        await sendMessage(chatId, formatMessage("خوش آمدید", "🌟 لطفاً ایمیل خود را وارد کنید (مثل example@domain.com):"));
        return;
      }
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

async function main() {
  await initSheetsClient();
  await ensureSheetHeaders();
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

main().catch(err => {
  console.error('Fatal error during startup', err);
  process.exit(1);
});