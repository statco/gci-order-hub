// api/lib/telegram.ts
// ─────────────────────────────────────────────────────────────
// Minimal Telegram sender for cron/operational summaries.
//
// Uses the "GCI Orders" bot (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — the
// same bot the order + price alerts use. Never throws: a notification
// failure must not fail the job that produced it; it only logs.
// ─────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

/**
 * Send a one-off message via the GCI Orders bot.
 * @param text       message body (HTML by default — escape any user data)
 * @param parseMode  Telegram parse mode; defaults to 'HTML'
 */
export async function sendTelegramMessage(
  text: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN/CHAT_ID not configured — skipping notification');
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`❌ Telegram notify failed ${res.status}:`, body.slice(0, 200));
    } else {
      console.log('✅ Telegram summary sent');
    }
  } catch (err) {
    console.error('❌ Telegram notify threw:', err instanceof Error ? err.message : String(err));
  }
}
