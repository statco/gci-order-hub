// api/lib/telegram.ts
// ─────────────────────────────────────────────────────────────
// Minimal Telegram sender for cron/operational summaries.
//
// Uses the "GCI Orders" bot (TELEGRAM_BOT_TOKEN) split across two chats by
// urgency, so actionable alerts (new orders, failures) don't compete for
// attention with informational summaries (heartbeats, audits) in the same
// feed:
//   TELEGRAM_CHAT_ID_ACTIONABLE — needs a human to look/act
//   TELEGRAM_CHAT_ID_INFO       — periodic summaries, nothing to do
// Both fall back to the pre-existing TELEGRAM_CHAT_ID when their own var is
// unset, so nothing breaks before the two new chats exist and their IDs are
// set. Never throws: a notification failure must not fail the job that
// produced it; it only logs.
// ─────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const TELEGRAM_CHAT_ID_ACTIONABLE = process.env.TELEGRAM_CHAT_ID_ACTIONABLE || TELEGRAM_CHAT_ID;
const TELEGRAM_CHAT_ID_INFO       = process.env.TELEGRAM_CHAT_ID_INFO       || TELEGRAM_CHAT_ID;

export type TelegramChannel = 'actionable' | 'info';

function resolveChatId(channel: TelegramChannel): string {
  return channel === 'actionable' ? TELEGRAM_CHAT_ID_ACTIONABLE : TELEGRAM_CHAT_ID_INFO;
}

/**
 * Send a one-off message via the GCI Orders bot.
 * @param text       message body (HTML by default — escape any user data)
 * @param channel    'actionable' (needs a human to look/act) or 'info'
 *                   (periodic summary, nothing to do) — see module header
 * @param parseMode  Telegram parse mode; defaults to 'HTML'
 * @returns true if the message was accepted by Telegram, false otherwise
 *          (including missing config). Never throws — a notification
 *          failure must not fail the job that produced it. Callers that
 *          need to know whether the send actually went out (e.g. to make a
 *          claim retryable on failure) can check the return value; existing
 *          callers that don't care can keep ignoring it.
 */
export async function sendTelegramMessage(
  text: string,
  channel: TelegramChannel,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
): Promise<boolean> {
  const chatId = resolveChatId(channel);
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.warn(`[telegram] TELEGRAM_BOT_TOKEN/chat id not configured for channel="${channel}" — skipping notification`);
    return false;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`❌ Telegram notify failed ${res.status}:`, body.slice(0, 200));
      return false;
    }
    console.log(`✅ Telegram summary sent (channel=${channel})`);
    return true;
  } catch (err) {
    console.error('❌ Telegram notify threw:', err instanceof Error ? err.message : String(err));
    return false;
  }
}
