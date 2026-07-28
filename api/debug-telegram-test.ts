// TEMPORARY — delivery verification for the walmart-order-sync Telegram
// alert PR. Confirms TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are set on THIS
// project and that a message actually reaches Telegram, since alerts have
// so far only ever been confirmed from gci-price-monitor (a different
// Vercel project with its own env vars). Remove before merging.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendTelegramMessage } from './lib/telegram.js';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const hasToken = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const hasChatId = Boolean(process.env.TELEGRAM_CHAT_ID);

  const sent = await sendTelegramMessage(
    `🧪 gci-order-hub Telegram delivery test (${new Date().toISOString()}) — safe to ignore.`
  );

  return res.status(200).json({ hasToken, hasChatId, sent });
}
