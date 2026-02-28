import 'dotenv/config';
import cron from 'node-cron';
import { ImapFlow } from 'imapflow';
import { createClient } from '@supabase/supabase-js';

let simpleParserFn = null;
try {
  const mailparserModule = await import('mailparser');
  simpleParserFn = mailparserModule?.simpleParser || null;
  console.log(`${new Date().toISOString()} [SYNC] mailparser loaded successfully`);
} catch (error) {
  console.warn(`${new Date().toISOString()} [SYNC] mailparser not available, using raw fallback parser: ${error?.message || error}`);
}

const chatTokenRegex = /\[CRM-CHAT:([0-9a-fA-F-]{36})\]/;
const fetchLimit = Number(process.env.FETCH_LIMIT || 50);
const syncCron = process.env.SYNC_CRON || '*/2 * * * *';
const accountEmailFilter = (process.env.ACCOUNT_EMAIL || '').trim().toLowerCase();
const accountIdFilter = (process.env.ACCOUNT_ID || '').trim();
const dryRun = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing env var: ${key}`);
  }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const ts = () => new Date().toISOString();

const toRecipientList = (addressObject) => {
  const value = addressObject?.value || [];
  return value
    .map((entry) => ({
      email: String(entry?.address || '').trim(),
      name: entry?.name ? String(entry.name).trim() : undefined,
    }))
    .filter((entry) => !!entry.email);
};

const looksLikeRawMimeSource = (value) => {
  if (!value) return false;
  const normalized = String(value).toLowerCase();
  return (
    normalized.includes('return-path:') &&
    normalized.includes('content-type:') &&
    normalized.includes('mime-version:')
  );
};

const looksLikeHtmlContent = (value) => {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  return (
    normalized.startsWith('<!doctype html') ||
    normalized.startsWith('<html') ||
    (normalized.includes('<body') && normalized.includes('</body>')) ||
    /<\/?[a-z][\s\S]*>/i.test(normalized)
  );
};

const stripHtml = (html) =>
  String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const parseMimeContent = async (source) => {
  if (!source) {
    return {
      subject: null,
      fromEmail: null,
      fromName: null,
      toList: [],
      ccList: [],
      bodyText: '',
      bodyHtml: '',
      attachments: [],
    };
  }

  if (!simpleParserFn) {
    const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source || '');
    if (looksLikeRawMimeSource(raw)) {
      return {
        subject: null,
        fromEmail: null,
        fromName: null,
        toList: [],
        ccList: [],
        bodyText: raw,
        bodyHtml: '',
        attachments: [],
      };
    }

    if (looksLikeHtmlContent(raw)) {
      return {
        subject: null,
        fromEmail: null,
        fromName: null,
        toList: [],
        ccList: [],
        bodyText: stripHtml(raw),
        bodyHtml: raw,
        attachments: [],
      };
    }

    return {
      subject: null,
      fromEmail: null,
      fromName: null,
      toList: [],
      ccList: [],
      bodyText: raw,
      bodyHtml: '',
      attachments: [],
    };
  }

  const parsed = await simpleParserFn(source);
  const from = parsed?.from?.value?.[0];
  let bodyText = String(parsed?.text || '').trim();
  let bodyHtml = typeof parsed?.html === 'string'
    ? parsed.html
    : (parsed?.html ? String(parsed.html) : '');

  if (!bodyHtml && looksLikeHtmlContent(bodyText)) {
    bodyHtml = bodyText;
    bodyText = stripHtml(bodyText);
  }

  if (!bodyText && bodyHtml) {
    bodyText = stripHtml(bodyHtml);
  }

  return {
    subject: parsed?.subject || null,
    fromEmail: from?.address ? String(from.address).trim() : null,
    fromName: from?.name ? String(from.name).trim() : null,
    toList: toRecipientList(parsed?.to),
    ccList: toRecipientList(parsed?.cc),
    bodyText: bodyText || (bodyHtml ? stripHtml(bodyHtml) : ''),
    bodyHtml,
    attachments: (parsed?.attachments || []).map((attachment) => ({
      filename: attachment?.filename || 'adjunto',
      size: Number(attachment?.size || 0),
      type: String(attachment?.contentType || 'application/octet-stream'),
    })),
  };
};

const buildImapConfigs = (account) => {
  const host = String(account.imap_host || '').trim().toLowerCase();
  const port = Number(account.imap_port) || (account.use_ssl ? 993 : 143);
  const secure = !!account.use_ssl || port === 993;

  const base = {
    host,
    auth: {
      user: String(account.imap_username || '').trim(),
      pass: String(account.imap_password || ''),
    },
    logger: false,
    disableAutoIdle: true,
  };

  return [
    {
      ...base,
      port,
      secure,
      ...(secure ? { doSTARTTLS: false } : { requireTLS: true, doSTARTTLS: true }),
      tls: { rejectUnauthorized: false, servername: host },
      greetingTimeout: 25000,
      socketTimeout: 25000,
      connectionTimeout: 25000,
      name: `saved(${port}/${secure ? 'ssl' : 'starttls'})`,
    },
    {
      ...base,
      port: 993,
      secure: true,
      doSTARTTLS: false,
      greetingTimeout: 20000,
      socketTimeout: 20000,
      connectionTimeout: 20000,
      name: 'ssl-993',
    },
    {
      ...base,
      port: 143,
      secure: false,
      requireTLS: true,
      doSTARTTLS: true,
      greetingTimeout: 18000,
      socketTimeout: 18000,
      connectionTimeout: 18000,
      name: 'starttls-143',
    },
  ];
};

const connectWithFallback = async (account) => {
  const configs = buildImapConfigs(account);
  const attempts = [];
  let lastError;

  for (const config of configs) {
    try {
      console.log(`${ts()} [IMAP] Trying ${account.email_address} -> ${config.name}`);
      const client = new ImapFlow(config);
      await client.connect();
      attempts.push({ name: config.name, success: true });
      return { client, attempts, used: config.name };
    } catch (error) {
      lastError = error;
      attempts.push({
        name: config.name,
        success: false,
        code: error?.code,
        error: error?.message,
      });
      console.error(`${ts()} [IMAP] Failed ${config.name}: ${error?.code || 'UNKNOWN'} ${error?.message || ''}`);
    }
  }

  const err = new Error(`All IMAP attempts failed: ${lastError?.message || 'Unknown error'}`);
  err.code = lastError?.code;
  err.attempts = attempts;
  throw err;
};

const upsertIncomingEmail = async ({ account, userId, message, sourceContent }) => {
  const envelopeMessageId = String(message.envelope?.messageId || '').trim();
  const messageId = envelopeMessageId || `imap-${account.id}-${message.uid}`;

  const { data: existing, error: existingError } = await supabase
    .from('inbox_emails')
    .select('id')
    .eq('account_id', account.id)
    .eq('message_id', messageId)
    .maybeSingle();

  if (existingError) {
    throw new Error(`existing check failed: ${existingError.message}`);
  }

  if (existing) {
    return { inserted: false, messageId };
  }

  const from = message.envelope?.from?.[0];
  const toList = (message.envelope?.to || [])
    .map((entry) => ({ email: entry?.address || '', name: entry?.name || undefined }))
    .filter((entry) => !!entry.email);

  const mime = await parseMimeContent(sourceContent);
  const normalizedToList = mime.toList.length > 0
    ? mime.toList
    : (toList.length > 0 ? toList : [{ email: account.email_address }]);
  const subject = mime.subject || message.envelope?.subject || '(Sin asunto)';
  const fromEmail = mime.fromEmail || from?.address || 'unknown';
  const fromName = mime.fromName || from?.name || fromEmail || 'Unknown';

  const row = {
    account_id: account.id,
    user_id: userId,
    message_id: messageId,
    thread_id: message.envelope?.inReplyTo || null,
    subject,
    from_email: fromEmail,
    from_name: fromName,
    to_emails: normalizedToList,
    cc_emails: mime.ccList,
    bcc_emails: [],
    received_at: message.envelope?.date || new Date().toISOString(),
    email_date: message.envelope?.date || new Date().toISOString(),
    body_text: mime.bodyText,
    body_html: mime.bodyHtml,
    attachments: mime.attachments,
    is_read: message.flags?.has('\\Seen') || false,
    is_starred: message.flags?.has('\\Flagged') || false,
    is_archived: false,
    is_deleted: false,
    folder: 'inbox',
    labels: [],
  };

  if (dryRun) {
    return { inserted: true, messageId, dryRun: true };
  }

  const { error: insertError } = await supabase
    .from('inbox_emails')
    .upsert(row, { onConflict: 'account_id,message_id', ignoreDuplicates: true });

  if (insertError) {
    throw new Error(`insert failed: ${insertError.message}`);
  }

  const conversationSubject = row.subject || '';
  const tokenMatch = conversationSubject.match(chatTokenRegex);
  const conversationId = tokenMatch?.[1] || null;

  if (conversationId) {
    await supabase.from('webchat_messages').insert({
      conversation_id: conversationId,
      sender_type: 'visitor',
      sender_id: `email:${messageId}`,
      sender_name: row.from_name,
      message: row.body_text.slice(0, 4000) || `(Respuesta por email) ${conversationSubject}`,
      attachments: row.attachments || [],
    });

    await supabase
      .from('webchat_conversations')
      .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', conversationId);
  }

  return { inserted: true, messageId };
};

const syncAccount = async (account) => {
  const userId = account.created_by || account.user_id;
  if (!userId) {
    console.warn(`${ts()} [SYNC] Skipping ${account.email_address}: missing user id`);
    return { synced: 0, skipped: 0, account: account.email_address };
  }

  const { client, used, attempts } = await connectWithFallback(account);
  console.log(`${ts()} [SYNC] Connected ${account.email_address} with ${used}`);

  let synced = 0;
  let skipped = 0;

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists || 0;
      if (total === 0) {
        return { synced, skipped, account: account.email_address, attempts };
      }

      const count = Math.min(fetchLimit, total);
      const start = Math.max(1, total - count + 1);

      for await (const message of client.fetch(`${start}:*`, {
        envelope: true,
        source: true,
        uid: true,
      })) {
        const sourceContent = message.source || '';
        try {
          const result = await upsertIncomingEmail({
            account,
            userId,
            message,
            sourceContent,
          });

          if (result.inserted) synced += 1;
          else skipped += 1;
        } catch (error) {
          console.error(`${ts()} [SYNC] Message process error: ${error?.message || error}`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    if (client.usable) {
      await client.logout().catch(() => null);
    }
  }

  return { synced, skipped, account: account.email_address, attempts };
};

const loadAccounts = async () => {
  let query = supabase
    .from('email_accounts')
    .select('*')
    .eq('is_active', true);

  if (accountIdFilter) {
    query = query.eq('id', accountIdFilter);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`load accounts failed: ${error.message}`);
  }

  let accounts = data || [];
  if (accountEmailFilter) {
    accounts = accounts.filter((acc) => String(acc.email_address || '').toLowerCase() === accountEmailFilter);
  }

  return accounts;
};

let running = false;
const runSync = async () => {
  if (running) {
    console.log(`${ts()} [SYNC] Previous cycle still running, skipping`);
    return;
  }
  running = true;

  try {
    const accounts = await loadAccounts();
    if (!accounts.length) {
      console.log(`${ts()} [SYNC] No active accounts found`);
      return;
    }

    console.log(`${ts()} [SYNC] Accounts to process: ${accounts.length}`);
    let totalSynced = 0;
    let totalSkipped = 0;

    for (const account of accounts) {
      try {
        const result = await syncAccount(account);
        totalSynced += result.synced;
        totalSkipped += result.skipped;
        console.log(`${ts()} [SYNC] ${result.account}: +${result.synced} synced, ${result.skipped} skipped`);
      } catch (error) {
        console.error(`${ts()} [SYNC] Account error ${account.email_address}: ${error?.message || error}`);
      }
    }

    console.log(`${ts()} [SYNC] Cycle complete. Synced=${totalSynced}, Skipped=${totalSkipped}`);
  } catch (error) {
    console.error(`${ts()} [SYNC] Cycle failed: ${error?.message || error}`);
  } finally {
    running = false;
  }
};

const once = process.argv.includes('--once');
if (once) {
  runSync().finally(() => process.exit(0));
} else {
  console.log(`${ts()} [SYNC] Worker started. Cron=${syncCron}, FetchLimit=${fetchLimit}, DryRun=${dryRun}`);
  runSync();
  cron.schedule(syncCron, runSync);
}
