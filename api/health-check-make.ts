// api/health-check-make.ts
//
// FIXED/ADDED 2026-07-02: found via a real incident, not proactively.
// gci-brain's social-scheduler cron ran successfully every scheduled time
// and Vercel showed zero errors -- but the Make.com scenario that actually
// publishes those posts (Instagram/Facebook/Pinterest) had been switched
// OFF since it was created on 2026-04-26. Over 2 months of generated
// posts queued up in Make.com's webhook queue with no error anywhere in
// this stack, because Make.com is a second, disconnected system that
// nothing else here monitors.
//
// This cron closes that blind spot: checks the scenario's paused state
// AND its most recent execution timestamp (catches "on but not actually
// running" too, not just "off"), and alerts via the same Telegram
// bot/chat already used for order/installer notifications -- one more
// message in a channel already being watched, not a new dashboard.
//
// Required env vars:
//   MAKE_API_TOKEN       — Make.com API token (Profile → API)
//   MAKE_TEAM_ID          — 2205971 for this org, from the scenario URL
//   MAKE_SCENARIO_ID       — 4867071, the social-posting scenario specifically
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — already set, reused from notify.ts

import type { VercelRequest, VercelResponse } from '@vercel/node';

const MAKE_API_TOKEN  = process.env.MAKE_API_TOKEN  || '';
const MAKE_TEAM_ID    = process.env.MAKE_TEAM_ID    || '';
const MAKE_SCENARIO_ID = process.env.MAKE_SCENARIO_ID || '';
const MAKE_ZONE        = process.env.MAKE_ZONE || 'us2'; // from the scenario URL (us2.make.com)

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID   || '';

// Loosest posting schedule is Pinterest (Mon-Fri). A 3-day gap comfortably
// covers a normal weekend without a real cron run, while still catching a
// genuinely stalled/paused scenario well before it becomes a multi-week
// silent outage like the one that prompted building this.
const MAX_STALE_DAYS = 3;

async function sendTelegramAlert(text: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) {
    console.error('[health-check-make] Telegram not configured, cannot alert:', text);
    return;
  }
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT,
      text: `🚨 *Make.com Health Check*\n\n${text}`,
      parse_mode: 'Markdown',
    }),
  });
}

async function makeApiGet(path: string): Promise<any> {
  const res = await fetch(`https://${MAKE_ZONE}.make.com/api/v2${path}`, {
    headers: { Authorization: `Token ${MAKE_API_TOKEN}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Make.com API ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  if (!MAKE_API_TOKEN || !MAKE_TEAM_ID || !MAKE_SCENARIO_ID) {
    return res.status(500).json({ error: 'MAKE_API_TOKEN / MAKE_TEAM_ID / MAKE_SCENARIO_ID not configured' });
  }

  const problems: string[] = [];

  try {
    // Check 1: is the scenario paused?
    const scenarioData = await makeApiGet(`/scenarios/${MAKE_SCENARIO_ID}?teamId=${MAKE_TEAM_ID}`);
    const scenario = scenarioData.scenario;
    if (scenario.isPaused) {
      problems.push(`Scenario "${scenario.name}" is currently *PAUSED*. Posts are queuing up, not publishing.`);
    }

    // Check 2: when did it last actually run?
    const logsData = await makeApiGet(`/scenarios/${MAKE_SCENARIO_ID}/logs?pg%5Blimit%5D=1`);
    const lastLog = logsData.scenarioLogs?.[0];
    if (!lastLog) {
      problems.push(`Scenario has *no execution history at all*.`);
    } else {
      const lastRunDate = new Date(lastLog.timestamp);
      const daysSince = (Date.now() - lastRunDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > MAX_STALE_DAYS) {
        problems.push(
          `Last execution was ${daysSince.toFixed(1)} days ago (${lastRunDate.toISOString()}) — ` +
          `longer than the ${MAX_STALE_DAYS}-day threshold. Scenario may be stuck even though it's not paused.`
        );
      }
      if (lastLog.status === 3) {
        problems.push(`Most recent execution *failed* (status: error).`);
      }
    }

    if (problems.length > 0) {
      await sendTelegramAlert(problems.map(p => `⚠️ ${p}`).join('\n\n'));
      return res.status(200).json({ healthy: false, problems });
    }

    return res.status(200).json({ healthy: true, lastExecution: lastLog?.timestamp });
  } catch (err: any) {
    console.error('[health-check-make] error:', err);
    await sendTelegramAlert(`Health check itself failed to run: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}
