// =================================================================
// CardDrop Live Backend Server (Node.js)
// Full Multi-User System: Leaderboard, Transfers, Market, 
// Server-side Bans, Prefixes (SPONSOR, DEVELOPER, SCAM), Promocodes ($0.000000),
// and 10% Referral System
// =================================================================
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const BOT_TOKEN = process.env.BOT_TOKEN || 'ВАШ_ТОКЕН_ОТ_BOTFATHER';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1190234';

function fmtUSD(val) {
    return '$' + Number(val || 0).toFixed(6);
}

// -------------------------------------------------------------
// DATABASE INITIALIZATION & PERSISTENCE
// -------------------------------------------------------------
function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const raw = fs.readFileSync(DB_FILE, 'utf8');
            const data = JSON.parse(raw);
            return {
                players: data.players || {},     // Map: userId -> player object
                market: data.market || [],       // Array of listings
                transfers: data.transfers || [], // Array of transfer logs
                promocodes: {
                    'DOLD30': { dollars: 0.050000, card: true },
                    'START2026': { dollars: 0.010000, card: false },
                    'CYBERFREE': { dollars: 0.005000, card: false },
                    ...(data.promocodes || {})
                }
            };
        }
    } catch (e) {
        console.error('[DB] Ошибка чтения базы данных:', e);
    }
    return {
        players: {},
        market: [],
        transfers: [],
        promocodes: {
            'DOLD30': { dollars: 0.050000, card: true },
            'START2026': { dollars: 0.010000, card: false },
            'CYBERFREE': { dollars: 0.005000, card: false }
        }
    };
}

function saveDB(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('[DB] Ошибка сохранения базы данных:', e);
    }
}

let db = loadDB();

// Helper to find player by ID or Username
function findPlayer(target) {
    if (!target) return null;
    const clean = String(target).trim().toLowerCase().replace('@', '');
    if (db.players[clean]) return db.players[clean];
    return Object.values(db.players).find(p => p.username === clean || String(p.id) === clean);
}

// -------------------------------------------------------------
// TELEGRAM BOT API NOTIFICATIONS HELPER
// -------------------------------------------------------------
function sendTelegramMessage(chatId, text) {
    if (!chatId || !BOT_TOKEN || BOT_TOKEN === 'ВАШ_ТОКЕН_ОТ_BOTFATHER') return;

    const payload = JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
    });

    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = https.request(options, (res) => {
        res.on('data', () => {});
    });
    req.on('error', (err) => console.error('[BOT NOTIFY ERROR]:', err.message));
    req.write(payload);
    req.end();
}

// -------------------------------------------------------------
// HTTP SERVER & REST API
// -------------------------------------------------------------
const server = http.createServer((req, res) => {
    // CORS headers for Telegram WebApp
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    const jsonRes = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    };

    const readBody = (callback) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                callback(JSON.parse(body || '{}'));
            } catch (e) {
                jsonRes(400, { error: 'Некорректный JSON формат' });
            }
        });
    };

    // ---------------------------------------------------------
    // 1. LEADERBOARD API: Real unbanned players
    // ---------------------------------------------------------
    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
        const playersArray = Object.values(db.players)
            .filter(p => !p.isBanned)
            .map(p => ({
                id: p.id,
                name: p.name,
                username: p.username,
                balance: Number(p.balance || 0),
                prefixText: p.prefixText || '',
                prefixCss: p.prefixCss || '',
                ad: p.ad || null
            }))
            .sort((a, b) => (b.balance || 0) - (a.balance || 0));

        return jsonRes(200, { success: true, players: playersArray });
    }

    // ---------------------------------------------------------
    // 2. PLAYER PROFILE SYNC: Sync balance, referrals, bans
    // ---------------------------------------------------------
    if (url.pathname === '/api/player/sync' && req.method === 'POST') {
        return readBody((data) => {
            if (!data.id) return jsonRes(400, { error: 'Не указан ID пользователя' });
            const id = String(data.id);

            let player = db.players[id];
            let isNewPlayer = false;

            if (!player) {
                isNewPlayer = true;
                player = {
                    id: id,
                    chatId: data.chatId || id,
                    name: data.name || 'Игрок',
                    username: (data.username || `user${id}`).replace('@', '').toLowerCase(),
                    balance: typeof data.balance === 'number' ? data.balance : 0.000000,
                    prefixText: '',
                    prefixCss: '',
                    isBanned: false,
                    referredBy: null,
                    referrals: [],
                    referralEarnings: 0.000000,
                    redeemedCodes: [],
                    ad: null,
                    lastSeen: Date.now()
                };
                db.players[id] = player;
            } else {
                if (data.name) player.name = data.name;
                if (data.username) player.username = data.username.replace('@', '').toLowerCase();
                if (data.chatId) player.chatId = data.chatId;

                // Update balance if not banned
                if (!player.isBanned && typeof data.balance === 'number') {
                    player.balance = data.balance;
                }
                player.lastSeen = Date.now();
            }

            // Bind Referral on first registration
            if (isNewPlayer && data.referredBy) {
                const refTarget = String(data.referredBy).trim().toLowerCase().replace('ref_', '').replace('@', '');
                if (refTarget && refTarget !== id) {
                    const referrer = findPlayer(refTarget);
                    if (referrer && referrer.id !== id) {
                        player.referredBy = referrer.id;
                        if (!referrer.referrals) referrer.referrals = [];
                        if (!referrer.referrals.includes(player.id)) {
                            referrer.referrals.push(player.id);
                        }
                        if (referrer.chatId) {
                            sendTelegramMessage(referrer.chatId, `🎉 *Новый реферал!*\n\nПользователь @${player.username} перешел по вашей ссылке! Вы будете получать *10%* от всех его доходов.`);
                        }
                    }
                }
            }

            // Process referral passive bonus from earnedDelta
            if (player.referredBy && typeof data.earnedDelta === 'number' && data.earnedDelta > 0 && !player.isBanned) {
                const referrer = db.players[player.referredBy];
                if (referrer && !referrer.isBanned) {
                    const bonus = data.earnedDelta * 0.10;
                    referrer.balance = (referrer.balance || 0) + bonus;
                    referrer.referralEarnings = (referrer.referralEarnings || 0) + bonus;
                }
            }

            saveDB(db);

            return jsonRes(200, {
                success: true,
                player: {
                    id: player.id,
                    name: player.name,
                    username: player.username,
                    balance: player.balance,
                    prefixText: player.prefixText,
                    prefixCss: player.prefixCss,
                    isBanned: player.isBanned,
                    referredBy: player.referredBy,
                    referralsCount: player.referrals ? player.referrals.length : 0,
                    referralEarnings: player.referralEarnings || 0.000000,
                    ad: player.ad
                }
            });
        });
    }

    // ---------------------------------------------------------
    // 3. REFERRAL STATS & 10% REWARD CREDIT
    // ---------------------------------------------------------
    if (url.pathname === '/api/referral/stats' && req.method === 'GET') {
        const userId = url.searchParams.get('userId');
        const player = findPlayer(userId);
        if (!player) return jsonRes(404, { error: 'Пользователь не найден' });

        const refList = (player.referrals || []).map(refId => {
            const refP = db.players[refId];
            return {
                id: refId,
                username: refP ? refP.username : 'user',
                name: refP ? refP.name : 'Игрок',
                balance: refP ? refP.balance : 0
            };
        });

        return jsonRes(200, {
            success: true,
            count: refList.length,
            earnings: player.referralEarnings || 0.000000,
            referrals: refList
        });
    }

    if (url.pathname === '/api/referral/credit' && req.method === 'POST') {
        return readBody((data) => {
            const { userId, earnedAmount, reason } = data;
            const earnAmt = parseFloat(earnedAmount);
            if (!userId || isNaN(earnAmt) || earnAmt <= 0) return jsonRes(400, { error: 'Некорректная сумма' });

            const player = findPlayer(userId);
            if (!player || !player.referredBy) {
                return jsonRes(200, { success: true, bonus: 0 });
            }

            const referrer = db.players[player.referredBy];
            if (!referrer || referrer.isBanned) {
                return jsonRes(200, { success: true, bonus: 0 });
            }

            const bonus = earnAmt * 0.10;
            referrer.balance = (referrer.balance || 0) + bonus;
            referrer.referralEarnings = (referrer.referralEarnings || 0) + bonus;
            saveDB(db);

            if (referrer.chatId) {
                sendTelegramMessage(referrer.chatId, `💸 *Реферальное начисление (10%)!*\n\nВаш реферал @${player.username} получил доход (${reason || 'игра'}): ${fmtUSD(earnAmt)}.\nВам зачислено: *+${fmtUSD(bonus)}*!\nВаш баланс: *${fmtUSD(referrer.balance)}*`);
            }

            return jsonRes(200, { success: true, bonus, referrer: referrer.username });
        });
    }

    // ---------------------------------------------------------
    // 4. SEARCH PLAYERS FOR TRANSFERS
    // ---------------------------------------------------------
    if (url.pathname === '/api/user/search' && req.method === 'GET') {
        const query = (url.searchParams.get('query') || '').trim().toLowerCase().replace('@', '');
        if (!query) return jsonRes(200, { success: true, results: [] });

        const results = Object.values(db.players)
            .filter(p => !p.isBanned && (p.username.includes(query) || p.name.toLowerCase().includes(query) || p.id === query))
            .slice(0, 5)
            .map(p => ({
                id: p.id,
                name: p.name,
                username: p.username,
                prefixText: p.prefixText
            }));

        return jsonRes(200, { success: true, results });
    }

    // ---------------------------------------------------------
    // 5. REAL P2P DOLLAR TRANSFERS WITH TELEGRAM NOTIFICATIONS
    // ---------------------------------------------------------
    if (url.pathname === '/api/transfer' && req.method === 'POST') {
        return readBody((data) => {
            const { senderId, targetUsername, amount, note } = data;
            const transferAmt = parseFloat(amount);

            if (!senderId || !targetUsername || isNaN(transferAmt) || transferAmt <= 0) {
                return jsonRes(400, { error: 'Некорректная сумма или получатель' });
            }

            const cleanTarget = targetUsername.trim().toLowerCase().replace('@', '');
            const sender = findPlayer(senderId);
            const recipient = findPlayer(cleanTarget);

            if (!sender) return jsonRes(404, { error: 'Отправитель не найден в базе' });
            if (sender.isBanned) return jsonRes(403, { error: 'Ваш аккаунт заблокирован' });
            if (!recipient) return jsonRes(404, { error: `Пользователь @${cleanTarget} еще не заходил в приложение` });
            if (recipient.isBanned) return jsonRes(400, { error: 'Получатель заблокирован в системе' });
            if (sender.id === recipient.id) return jsonRes(400, { error: 'Нельзя переводить доллары самому себе' });
            if (sender.balance < transferAmt) return jsonRes(400, { error: 'Недостаточно средств на балансе' });

            // Deduct and credit
            sender.balance -= transferAmt;
            recipient.balance += transferAmt;

            const record = {
                id: Date.now(),
                fromId: sender.id,
                fromUsername: sender.username,
                toId: recipient.id,
                toUsername: recipient.username,
                amount: transferAmt,
                note: note || '',
                timestamp: Date.now()
            };
            db.transfers.unshift(record);
            saveDB(db);

            // Send notification to recipient in Telegram!
            if (recipient.chatId) {
                const notifyText = `💸 *Вам поступил перевод!*\n\n` +
                                   `От: @${sender.username}\n` +
                                   `Сумма: *+${fmtUSD(transferAmt)}*\n` +
                                   (note ? `Комментарий: _"${note}"_\n\n` : '\n') +
                                   `Ваш новый баланс: *${fmtUSD(recipient.balance)}*`;
                sendTelegramMessage(recipient.chatId, notifyText);
            }

            return jsonRes(200, {
                success: true,
                newBalance: sender.balance,
                recipient: recipient.username,
                amount: transferAmt,
                record
            });
        });
    }

    // ---------------------------------------------------------
    // 6. GET TRANSFER HISTORY
    // ---------------------------------------------------------
    if (url.pathname === '/api/transfers' && req.method === 'GET') {
        const userId = url.searchParams.get('userId');
        if (!userId) return jsonRes(200, { success: true, history: [] });

        const history = db.transfers
            .filter(t => t.fromId === userId || t.toId === userId)
            .slice(0, 15);

        return jsonRes(200, { success: true, history });
    }

    // ---------------------------------------------------------
    // 7. REAL P2P MARKETPLACE
    // ---------------------------------------------------------
    if (url.pathname === '/api/market' && req.method === 'GET') {
        return jsonRes(200, { success: true, listings: db.market });
    }

    if (url.pathname === '/api/market/list' && req.method === 'POST') {
        return readBody((data) => {
            const { sellerId, sellerName, card, price } = data;
            if (!sellerId || !card || !price || parseFloat(price) <= 0) {
                return jsonRes(400, { error: 'Некорректные данные лота' });
            }

            const seller = findPlayer(sellerId);
            if (seller && seller.isBanned) return jsonRes(403, { error: 'Аккаунт заблокирован' });

            const newListing = {
                id: Date.now(),
                sellerId: String(sellerId),
                sellerName: sellerName || `@${seller?.username || 'player'}`,
                card: card,
                price: parseFloat(price),
                createdAt: Date.now()
            };

            db.market.unshift(newListing);
            saveDB(db);

            return jsonRes(200, { success: true, listing: newListing, listings: db.market });
        });
    }

    if (url.pathname === '/api/market/buy' && req.method === 'POST') {
        return readBody((data) => {
            const { listingId, buyerId } = data;
            const listingIdx = db.market.findIndex(l => l.id === listingId);
            if (listingIdx === -1) return jsonRes(404, { error: 'Лот не найден или уже был куплен' });

            const listing = db.market[listingIdx];
            if (String(listing.sellerId) === String(buyerId)) {
                return jsonRes(400, { error: 'Вы не можете купить свой собственный лот' });
            }

            const buyer = findPlayer(buyerId);
            const seller = findPlayer(listing.sellerId);

            if (!buyer) return jsonRes(404, { error: 'Покупатель не найден' });
            if (buyer.isBanned) return jsonRes(403, { error: 'Аккаунт покупателя заблокирован' });
            if (buyer.balance < listing.price) {
                return jsonRes(400, { error: 'Недостаточно средств для покупки' });
            }

            // Execute transaction with 8% commission
            const fee = listing.price * 0.08;
            const payout = listing.price - fee;

            buyer.balance -= listing.price;
            if (seller) {
                seller.balance += payout;
                // If seller was referred, 10% bonus goes to referrer
                if (seller.referredBy) {
                    const sellerRef = db.players[seller.referredBy];
                    if (sellerRef && !sellerRef.isBanned) {
                        const refBonus = payout * 0.10;
                        sellerRef.balance = (sellerRef.balance || 0) + refBonus;
                        sellerRef.referralEarnings = (sellerRef.referralEarnings || 0) + refBonus;
                    }
                }

                if (seller.chatId) {
                    const notify = `🎉 *Ваша карта куплена на бирже!*\n\n` +
                                   `Карта: *${listing.card.bank}* (${listing.card.material})\n` +
                                   `Покупатель: @${buyer.username}\n` +
                                   `Сумма продажи: *${fmtUSD(listing.price)}*\n` +
                                   `Зачислено вам (комиссия 8%): *+${fmtUSD(payout)}*`;
                    sendTelegramMessage(seller.chatId, notify);
                }
            }

            const purchasedCard = listing.card;
            db.market.splice(listingIdx, 1);
            saveDB(db);

            return jsonRes(200, {
                success: true,
                boughtCard: purchasedCard,
                newBalance: buyer.balance,
                listings: db.market
            });
        });
    }

    if (url.pathname === '/api/market/cancel' && req.method === 'POST') {
        return readBody((data) => {
            const { listingId, sellerId } = data;
            const idx = db.market.findIndex(l => l.id === listingId && String(l.sellerId) === String(sellerId));
            if (idx === -1) return jsonRes(404, { error: 'Лот не найден' });

            const card = db.market[idx].card;
            db.market.splice(idx, 1);
            saveDB(db);

            return jsonRes(200, { success: true, returnedCard: card, listings: db.market });
        });
    }

    // ---------------------------------------------------------
    // 8. SHOWCASE AD SETTING (LEADERBOARD ADS)
    // ---------------------------------------------------------
    if (url.pathname === '/api/ad/set' && req.method === 'POST') {
        return readBody((data) => {
            const { userId, ad } = data;
            const player = findPlayer(userId);
            if (!player) return jsonRes(404, { error: 'Игрок не найден' });
            if (player.isBanned) return jsonRes(403, { error: 'Аккаунт заблокирован' });

            player.ad = ad || null;
            saveDB(db);

            return jsonRes(200, { success: true, ad: player.ad });
        });
    }

    // ---------------------------------------------------------
    // 9. SERVER-SIDE PROMOCODES SYSTEM
    // ---------------------------------------------------------
    if (url.pathname === '/api/promo/redeem' && req.method === 'POST') {
        return readBody((data) => {
            const { userId, code } = data;
            const cleanCode = (code || '').trim().toUpperCase();
            const player = findPlayer(userId);

            if (!player) return jsonRes(404, { error: 'Игрок не найден' });
            if (player.isBanned) return jsonRes(403, { error: 'Аккаунт заблокирован' });

            if (!player.redeemedCodes) player.redeemedCodes = [];
            if (player.redeemedCodes.includes(cleanCode)) {
                return jsonRes(400, { error: 'Вы уже активировали этот промокод!' });
            }

            const promo = db.promocodes[cleanCode];
            if (!promo) {
                return jsonRes(404, { error: 'Промокод не существует' });
            }

            const reward = promo.dollars || promo.tokens || 0.010000;
            player.balance += reward;
            player.redeemedCodes.push(cleanCode);
            saveDB(db);

            return jsonRes(200, {
                success: true,
                rewardDollars: reward,
                rewardCard: promo.card,
                newBalance: player.balance
            });
        });
    }

    // ---------------------------------------------------------
    // 10. ADMIN SYSTEM: BAN, UNBAN, PREFIXES, MONEY
    // ---------------------------------------------------------
    if (url.pathname === '/api/admin/auth' && req.method === 'POST') {
        return readBody((data) => {
            if (data.password === ADMIN_PASSWORD) {
                return jsonRes(200, { success: true });
            }
            return jsonRes(401, { error: 'Неверный пароль администратора' });
        });
    }

    if (url.pathname === '/api/admin/money' && req.method === 'POST') {
        return readBody((data) => {
            if (data.password !== ADMIN_PASSWORD) return jsonRes(401, { error: 'Отказано в доступе' });
            const { targetId, amount } = data;
            const player = findPlayer(targetId);
            if (!player) return jsonRes(404, { error: 'Пользователь не найден' });

            player.balance += parseFloat(amount);
            saveDB(db);
            return jsonRes(200, { success: true, newBalance: player.balance, player });
        });
    }

    if (url.pathname === '/api/admin/prefix' && req.method === 'POST') {
        return readBody((data) => {
            if (data.password !== ADMIN_PASSWORD) return jsonRes(401, { error: 'Отказано в доступе' });
            const { targetId, prefixText, prefixCss } = data;
            const player = findPlayer(targetId);
            if (!player) return jsonRes(404, { error: 'Пользователь не найден' });

            let finalCss = prefixCss;
            const cleanText = (prefixText || '').trim().toUpperCase();

            if (cleanText === 'DEVELOPER') {
                finalCss = 'bg-red-950 text-red-400 border border-red-500/60 font-black';
            } else if (cleanText === 'SPONSOR') {
                finalCss = 'bg-amber-950 text-amber-300 border border-amber-500/60 font-black';
            } else if (cleanText === 'SCAM') {
                finalCss = 'bg-red-600 text-white font-black animate-pulse';
            } else if (!finalCss) {
                finalCss = 'bg-blue-950 text-blue-400 border border-blue-500/60 font-bold';
            }

            player.prefixText = prefixText || '';
            player.prefixCss = finalCss;
            saveDB(db);

            return jsonRes(200, { success: true, player });
        });
    }

    if (url.pathname === '/api/admin/ban' && req.method === 'POST') {
        return readBody((data) => {
            if (data.password !== ADMIN_PASSWORD) return jsonRes(401, { error: 'Отказано в доступе' });
            const { targetId, isBanned } = data;
            const player = findPlayer(targetId);
            if (!player) return jsonRes(404, { error: 'Пользователь не найден' });

            player.isBanned = Boolean(isBanned);
            if (player.isBanned) player.ad = null;
            saveDB(db);

            if (player.chatId) {
                const banMsg = player.isBanned 
                    ? `⚠️ *Ваш аккаунт в CardDrop был заблокирован администратором.*\nДля апелляции напишите @dold30`
                    : `✅ *Ваш аккаунт в CardDrop был успешно разблокирован!* Приятной игры.`;
                sendTelegramMessage(player.chatId, banMsg);
            }

            return jsonRes(200, { success: true, player });
        });
    }

    if (url.pathname === '/api/admin/players' && req.method === 'GET') {
        const pass = url.searchParams.get('password');
        if (pass !== ADMIN_PASSWORD) return jsonRes(401, { error: 'Отказано в доступе' });

        return jsonRes(200, { success: true, players: Object.values(db.players) });
    }

    // ---------------------------------------------------------
    // 11. STATIC FILES SERVING (WEB APP HTML/CSS/JS)
    // ---------------------------------------------------------
    let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const mimeTypes = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json'
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
        fs.createReadStream(filePath).pipe(res);
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`CardDrop Master Server is running 24/7 on PORT: ${PORT}`);
    console.log(`Features: Leaderboard | Transfers | Market | Bans | Prefixes`);
    console.log(`Currency: USD ($0.000000) | Referral System: 10% Active`);
    console.log(`Roulette Cases: $1 (Обычная), $100 (Улучшенная), $1000 (Элитная)`);
    console.log(`====================================================`);

    // Auto-launch Telegram Bot in the same process if token is provided
    if (process.env.BOT_TOKEN && process.env.BOT_TOKEN !== 'ВАШ_ТОКЕН_ОТ_BOTFATHER') {
        try {
            require('./bot.js');
            console.log('[AUTO-START] Telegram Bot успешно запущен вместе с сервером!');
        } catch (err) {
            console.error('[AUTO-START] Ошибка запуска бота:', err);
        }
    }
});
