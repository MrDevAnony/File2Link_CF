/**
 * A Cloudflare Worker that acts as a Telegram bot to generate direct download links.
 *
 * Configuration is managed via the Cloudflare dashboard:
 * - BOT_TOKEN (Secret): Your secret Telegram bot token.
 * - WORKER_DOMAIN (Variable): Your worker's full URL (e.g., https://your-worker.your-name.workers.dev).
 * - CHANNEL_ID (Variable): The numeric ID of the required channel (e.g., -100123456789).
 * - CHANNEL_USERNAME (Variable): The public username of the channel (e.g., @MyChannel).
 * - LINKS_KV (KV Binding): The KV namespace for storing link metadata.
 *
 * https://t.me/DevAmirw
 */

// --- Constants ---
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB (Telegram Bot API download limit)

// --- Event Listener ---
addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});

/**
 * Main request router.
 * @param {Request} request The incoming request.
 * @returns {Promise<Response>}
 */
async function handleRequest(request) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');

    switch (pathParts[1]) {
        case 'webhook':
            return handleTelegramWebhook(request);
        case 'file':
            const userId = pathParts[2];
            const token = pathParts[3];
            return serveFile(userId, token);
        default:
            return new Response('Not Found', { status: 404 });
    }
}

/**
 * Handles incoming updates from the Telegram webhook.
 * @param {Request} request The request from Telegram.
 * @returns {Promise<Response>}
 */
async function handleTelegramWebhook(request) {
    if (request.method !== 'POST') {
        return new Response('Invalid request method', { status: 405 });
    }

    const update = await request.json();
    if (!update.message?.chat?.id || !update.message?.from?.id) {
        return new Response('OK', { status: 200 });
    }

    const { message } = update;
    const chatId = message.chat.id;
    const userId = message.from.id;

    if (!(await isUserMember(userId))) {
        return sendTelegramMessage(chatId, `⛔ To use this bot, you must first join ${CHANNEL_USERNAME}.`);
    }

    if (message.text) {
        if (message.text === '/start') {
            return sendTelegramMessage(chatId, '👋 Hi! Send me a file (up to 20MB), and I will generate a direct download link for you.');
        }
        if (message.text.startsWith('/links')) {
            return sendUserLinks(chatId, userId);
        }
    }

    const { fileId, fileName, fileSize } = extractFileInfo(message);
    if (!fileId || !fileName) {
        return sendTelegramMessage(chatId, '❗ Please send a valid file.');
    }

    if (fileSize > MAX_FILE_SIZE) {
        return sendTelegramMessage(chatId, '❌ Sorry, bots cannot process files larger than 20MB.');
    }

    const token = crypto.randomUUID();
    const key = `user:${userId}:${token}`;
    await LINKS_KV.put(key, JSON.stringify({ fileId, fileName, fileSize }));

    const link = `${WORKER_DOMAIN}/file/${userId}/${token}`;
    return sendTelegramMessage(chatId, `✅ Your download link is ready:\n\`${link}\`\n\n⚠️ This is a direct link from Telegram and may expire after a while.`);
}

/**
 * Serves a file by looking up its metadata in KV and proxying from Telegram.
 * @param {string} userId The user ID from the URL.
 * @param {string} token The unique token from the URL.
 * @returns {Promise<Response>}
 */
async function serveFile(userId, token) {
    if (!userId || !token) {
        return new Response('⛔ Missing user ID or token.', { status: 400 });
    }

    const key = `user:${userId}:${token}`;
    const metaStr = await LINKS_KV.get(key);
    if (!metaStr) {
        return new Response('⛔ This link is invalid or has expired.', { status: 403 });
    }

    const meta = JSON.parse(metaStr);
    const telegramFileUrl = await getTelegramFileLink(meta.fileId);

    if (!telegramFileUrl) {
        await LINKS_KV.delete(key);
        return new Response('❌ Could not retrieve file from Telegram. The link may have expired.', { status: 502 });
    }

    const fileResponse = await fetch(telegramFileUrl);
    const headers = new Headers(fileResponse.headers);

    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.fileName)}"`);

    return new Response(fileResponse.body, {
        status: fileResponse.status,
        statusText: fileResponse.statusText,
        headers: headers,
    });
}

/**
 * Sends a list of a user's active links.
 * @param {number} chatId The chat to send the message to.
 * @param {number} userId The user whose links to list.
 * @returns {Promise<Response>}
 */
async function sendUserLinks(chatId, userId) {
    const list = await LINKS_KV.list({ prefix: `user:${userId}:` });
    if (list.keys.length === 0) {
        return sendTelegramMessage(chatId, 'ℹ️ You have no active links.');
    }

    let message = '🔗 Your active links:\n\n';
    for (const key of list.keys) {
        const value = await LINKS_KV.get(key.name);
        if (!value) continue;

        const meta = JSON.parse(value);
        const token = key.name.split(':')[2];
        const link = `${WORKER_DOMAIN}/file/${userId}/${token}`;
        const sizeMB = (meta.fileSize / 1024 / 1024).toFixed(2);

        message += `• ${meta.fileName} (${sizeMB} MB)\n\`${link}\`\n\n`;
    }

    return sendTelegramMessage(chatId, message);
}

// --- Helper Functions ---

/**
 * Extracts file information from a Telegram message object.
 * @param {object} message A Telegram message.
 * @returns {{fileId?: string, fileName?: string, fileSize?: number}}
 */
function extractFileInfo(message) {
    const file = message.document || message.video || message.audio || message.photo?.[message.photo.length - 1];
    if (!file) return {};

    const fileName = file.file_name || (message.video ? 'video.mp4' : message.audio ? 'audio.mp3' : 'photo.jpg');
    return { fileId: file.file_id, fileName: fileName, fileSize: file.file_size };
}

/**
 * Checks if a user is a member of the required channel.
 * @param {number} userId The user's Telegram ID.
 * @returns {Promise<boolean>}
 */
async function isUserMember(userId) {
    const TELEGRAM_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
    try {
        const response = await fetch(`${TELEGRAM_API_URL}/getChatMember?chat_id=${CHANNEL_ID}&user_id=${userId}`);
        const data = await response.json();
        return data.ok && ['member', 'creator', 'administrator'].includes(data.result.status);
    } catch (error) {
        console.error('Failed to check user membership:', error);
        return false;
    }
}

/**
 * Sends a text message via the Telegram Bot API.
 * @param {number} chatId The recipient's chat ID.
 * @param {string} text The message text to send.
 * @returns {Promise<Response>} A Response object to satisfy the event handler.
 */
async function sendTelegramMessage(chatId, text) {
    const TELEGRAM_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
    await fetch(`${TELEGRAM_API_URL}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' }),
    });
    return new Response('OK', { status: 200 });
}

/**
 * Gets a temporary file download path from Telegram.
 * @param {string} fileId The file_id of the file.
 * @returns {Promise<string|null>} The full URL to download the file or null if failed.
 */
async function getTelegramFileLink(fileId) {
    const TELEGRAM_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
    try {
        const response = await fetch(`${TELEGRAM_API_URL}/getFile?file_id=${fileId}`);
        const data = await response.json();
        if (!data.ok) return null;
        return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
    } catch (error) {
        console.error('Failed to get file link:', error);
        return null;
    }
}