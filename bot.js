// =================================================================
// Telegram Bot для CardDrop Mini App
// Отвечает на /start, поддерживает реферальную систему (10%),
// регистрирует chatId для уведомлений о переводах и покупках
// Поддерживает админ-команды (/give, /ban, /unban, /prefix)
// =================================================================
const https = require('https');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN || 'ВАШ_ТОКЕН_ОТ_BOTFATHER';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-domain.vercel.app';
const DB_FILE = path.join(__dirname, 'database.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1190234';

function fmtUSD(val) {
    return '$' + Number(val || 0).toFixed(6);
}

function getDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch(e) {}
    return { players: {}, market: [], transfers: [] };
}

function saveDB(db) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch(e) {}
}

function apiRequest(method, data) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let resBody = '';
            res.on('data', chunk => resBody += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(resBody));
                } catch (e) {
                    resolve({ ok: false, description: resBody });
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Отправка приветственного сообщения с реферальной поддержкой
async function sendWelcome(chatId, user, refParam) {
    const db = getDB();
    const userId = String(user.id);
    const username = (user.username || `user${userId}`).replace('@', '').toLowerCase();

    // Register / update player in database
    if (!db.players[userId]) {
        db.players[userId] = {
            id: userId,
            chatId: chatId,
            name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Игрок',
            username: username,
            balance: 0.000000,
            prefixText: '',
            prefixCss: '',
            isBanned: false,
            referredBy: null,
            referrals: [],
            referralEarnings: 0.000000,
            lastSeen: Date.now()
        };

        // Attach referral if valid
        if (refParam && String(refParam) !== userId) {
            const cleanRef = String(refParam).replace('ref_', '').toLowerCase();
            const referrer = db.players[cleanRef] || Object.values(db.players).find(p => p.username === cleanRef);
            if (referrer && referrer.id !== userId) {
                db.players[userId].referredBy = referrer.id;
                if (!referrer.referrals) referrer.referrals = [];
                if (!referrer.referrals.includes(userId)) referrer.referrals.push(userId);
                if (referrer.chatId) {
                    await apiRequest('sendMessage', {
                        chat_id: referrer.chatId,
                        text: `🎉 *Новый реферал!*\n\nПользователь @${username} запустил игру по вашей ссылке! Вы будете получать *10%* от всех его доходов навсегда.`,
                        parse_mode: 'Markdown'
                    });
                }
            }
        }
    } else {
        db.players[userId].chatId = chatId;
        db.players[userId].username = username;
        db.players[userId].lastSeen = Date.now();
    }
    saveDB(db);

    const text = `👋 Привет, *${user.first_name || 'Игрок'}*!\n\n` +
                 `💳 Добро пожаловать в *CardDrop Cyber App*!\n\n` +
                 `🔥 *Игровой процесс:*\n` +
                 `• *Пассивный Майнинг:* капает в долларах каждую секунду ($0.000000)\n` +
                 `• *3 Кейса:* Обычный ($1), Улучшенный ($100), Элитный ($1000)\n` +
                 `• *Реферальная система:* зови друзей и получай *10%* от всех их доходов!\n` +
                 `• *3D Карты:* 6 материалов (Бронза, Серебро, Золото, Металл, Карбон, Обсидиан)\n` +
                 `• *P2P Рынок и Переводы:* торгуй картами и переводи $ друзьям\n\n` +
                 `Нажми кнопку ниже, чтобы запустить игру прямо сейчас:`;

    const replyMarkup = {
        inline_keyboard: [
            [
                {
                    text: '🚀 Играть в CardDrop ($)',
                    web_app: { url: WEBAPP_URL }
                }
            ],
            [
                {
                    text: '👥 Моя реферальная ссылка (10%)',
                    callback_data: 'my_ref'
                }
            ],
            [
                {
                    text: '💬 Создатель & Поддержка @dold30',
                    url: 'https://t.me/dold30'
                }
            ]
        ]
    };

    try {
        await apiRequest('sendMessage', {
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
        });
    } catch (e) {
        console.error('[BOT ERROR]:', e.message);
    }
}

// Обработка текстовых команд
async function handleCommand(chatId, text, user) {
    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();
    const db = getDB();
    const userId = String(user.id);
    const username = (user.username || '').toLowerCase();

    // 1. /balance
    if (cmd === '/balance') {
        const player = db.players[userId];
        const bal = player ? fmtUSD(player.balance) : '$0.000000';
        const prefix = player?.prefixText ? ` [${player.prefixText}]` : '';
        await apiRequest('sendMessage', {
            chat_id: chatId,
            text: `💳 Ваш баланс: *${bal}*${prefix}\nID: \`${userId}\``,
            parse_mode: 'Markdown'
        });
        return;
    }

    // 2. /ref
    if (cmd === '/ref' || cmd === '/referrals') {
        const player = db.players[userId];
        const refCount = player?.referrals ? player.referrals.length : 0;
        const refEarn = player?.referralEarnings ? fmtUSD(player.referralEarnings) : '$0.000000';
        const botUsername = 'CardDropCyberBot';
        const refLink = `https://t.me/${botUsername}?start=ref_${userId}`;

        await apiRequest('sendMessage', {
            chat_id: chatId,
            text: `👥 *Реферальная Программа (10%)*\n\n` +
                  `Приглашено друзей: *${refCount} чел.*\n` +
                  `Заработано с рефералов: *${refEarn}*\n\n` +
                  `🔗 Ваша реферальная ссылка:\n\`${refLink}\`\n\n` +
                  `Отправьте эту ссылку друзьям — вы будете получать *10%* от всех их доходов!`,
            parse_mode: 'Markdown'
        });
        return;
    }

    // 3. /help
    if (cmd === '/help') {
        await apiRequest('sendMessage', {
            chat_id: chatId,
            text: `📋 *Команды бота:*\n\n` +
                  `/start — Главное меню и запуск игры\n` +
                  `/balance — Проверить свой баланс\n` +
                  `/ref — Ваша реферальная ссылка (10%)\n` +
                  `Поддержка: @dold30\n\n` +
                  `👑 *Команды админа (Пароль 1190234):*\n` +
                  `/give @username 1.0 — выдать баланс в $\n` +
                  `/ban @username — забанить игрока\n` +
                  `/unban @username — разбанить\n` +
                  `/prefix @username SPONSOR|DEVELOPER|SCAM — выдать префикс`,
            parse_mode: 'Markdown'
        });
        return;
    }

    // Admin Commands check
    const isAdmin = username === 'dold30' || db.players[userId]?.prefixText === 'DEVELOPER' || db.players[userId]?.prefixText === 'Разраб';

    if (cmd === '/give' && isAdmin) {
        const target = (parts[1] || '').replace('@', '').toLowerCase();
        const amt = parseFloat(parts[2]);
        if (!target || isNaN(amt)) {
            return apiRequest('sendMessage', { chat_id: chatId, text: 'Использование: /give @username 100.0' });
        }
        const recipient = Object.values(db.players).find(p => p.username === target || String(p.id) === target);
        if (!recipient) return apiRequest('sendMessage', { chat_id: chatId, text: `Игрок @${target} не найден.` });

        recipient.balance += amt;
        saveDB(db);
        await apiRequest('sendMessage', { chat_id: chatId, text: `✅ Выдано ${fmtUSD(amt)} игроку @${recipient.username}. Новый баланс: ${fmtUSD(recipient.balance)}` });
        if (recipient.chatId) {
            await apiRequest('sendMessage', { chat_id: recipient.chatId, text: `👑 Администратор начислил вам *+${fmtUSD(amt)}*!`, parse_mode: 'Markdown' });
        }
        return;
    }

    if (cmd === '/ban' && isAdmin) {
        const target = (parts[1] || '').replace('@', '').toLowerCase();
        const recipient = Object.values(db.players).find(p => p.username === target || String(p.id) === target);
        if (!recipient) return apiRequest('sendMessage', { chat_id: chatId, text: `Игрок @${target} не найден.` });

        recipient.isBanned = true;
        recipient.ad = null;
        saveDB(db);
        await apiRequest('sendMessage', { chat_id: chatId, text: `🔨 Игрок @${recipient.username} заблокирован!` });
        if (recipient.chatId) {
            await apiRequest('sendMessage', { chat_id: recipient.chatId, text: `⚠️ *Ваш аккаунт в CardDrop был заблокирован администратором.*\nДля апелляции напишите @dold30`, parse_mode: 'Markdown' });
        }
        return;
    }

    if (cmd === '/unban' && isAdmin) {
        const target = (parts[1] || '').replace('@', '').toLowerCase();
        const recipient = Object.values(db.players).find(p => p.username === target || String(p.id) === target);
        if (!recipient) return apiRequest('sendMessage', { chat_id: chatId, text: `Игрок @${target} не найден.` });

        recipient.isBanned = false;
        saveDB(db);
        await apiRequest('sendMessage', { chat_id: chatId, text: `✅ Игрок @${recipient.username} успешно разблокирован!` });
        if (recipient.chatId) {
            await apiRequest('sendMessage', { chat_id: recipient.chatId, text: `✅ *Ваш аккаунт был разблокирован!* Приятной игры.`, parse_mode: 'Markdown' });
        }
        return;
    }

    if (cmd === '/prefix' && isAdmin) {
        const target = (parts[1] || '').replace('@', '').toLowerCase();
        const rawPrefix = parts.slice(2).join(' ').trim();
        const cleanUpper = rawPrefix.toUpperCase();
        const recipient = Object.values(db.players).find(p => p.username === target || String(p.id) === target);
        if (!recipient) return apiRequest('sendMessage', { chat_id: chatId, text: `Игрок @${target} не найден.` });

        let finalPrefix = rawPrefix || 'SPONSOR';
        let finalCss = 'bg-blue-950 text-blue-400 border border-blue-500/60 font-bold';

        if (cleanUpper === 'DEVELOPER') {
            finalPrefix = 'DEVELOPER';
            finalCss = 'bg-red-950 text-red-400 border border-red-500/60 font-black';
        } else if (cleanUpper === 'SPONSOR') {
            finalPrefix = 'SPONSOR';
            finalCss = 'bg-amber-950 text-amber-300 border border-amber-500/60 font-black';
        } else if (cleanUpper === 'SCAM') {
            finalPrefix = 'SCAM';
            finalCss = 'bg-red-600 text-white font-black animate-pulse';
        }

        recipient.prefixText = finalPrefix;
        recipient.prefixCss = finalCss;
        saveDB(db);
        await apiRequest('sendMessage', { chat_id: chatId, text: `✅ Установлен префикс [${finalPrefix}] для @${recipient.username}` });
        return;
    }
}

// Long Polling Loop
let offset = 0;
async function pollUpdates() {
    try {
        const res = await apiRequest('getUpdates', { offset, timeout: 30 });
        if (res.ok && Array.isArray(res.result)) {
            for (const update of res.result) {
                offset = update.update_id + 1;

                if (update.callback_query) {
                    const cb = update.callback_query;
                    if (cb.data === 'my_ref') {
                        const userId = String(cb.from.id);
                        const db = getDB();
                        const p = db.players[userId];
                        const count = p?.referrals ? p.referrals.length : 0;
                        const earn = p?.referralEarnings ? fmtUSD(p.referralEarnings) : '$0.000000';
                        const link = `https://t.me/CardDropCyberBot?start=ref_${userId}`;

                        await apiRequest('sendMessage', {
                            chat_id: cb.message.chat.id,
                            text: `👥 *Реферальная система (10%)*\n\n` +
                                  `Приглашено: *${count} чел.*\n` +
                                  `Заработано: *${earn}*\n\n` +
                                  `Ваша ссылка:\n\`${link}\``,
                            parse_mode: 'Markdown'
                        });
                    }
                    continue;
                }

                if (update.message && update.message.text) {
                    const text = update.message.text.trim();
                    const chatId = update.message.chat.id;
                    const fromUser = update.message.from;

                    if (text.startsWith('/start')) {
                        const parts = text.split(' ');
                        const refParam = parts.length > 1 ? parts[1].replace('ref_', '') : null;
                        await sendWelcome(chatId, fromUser, refParam);
                    } else if (text.startsWith('/')) {
                        await handleCommand(chatId, text, fromUser);
                    }
                }
            }
        }
    } catch (err) {
        // network retry
    }
    setTimeout(pollUpdates, 1000);
}

if (BOT_TOKEN !== 'ВАШ_ТОКЕН_ОТ_BOTFATHER') {
    console.log('[BOT] Запущен Telegram Bot CardDrop (Long Polling)');
    pollUpdates();
} else {
    console.log('[BOT] Токен не указан. Укажите BOT_TOKEN для запуска бота.');
}
