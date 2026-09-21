import { Context } from 'hono';
import { cleanup } from './common';
import { CONSTANTS } from './constants';
import { getJsonSetting } from './utils';
import { CleanupSettings } from './models';
import { executeCustomSqlCleanup } from './admin_api/cleanup_api';
import type { MailAuditLogEntry } from './email/audit_log';

/**
 * 将 KV 中暂存的邮件流转审计日志批量落库至 D1 数据表，并删除已归档的 KV 键
 */
async function archiveMailAuditLogsToD1(env: Bindings): Promise<void> {
	if (!env.KV || !env.DB) return;
	try {
		console.log('Starting archiveMailAuditLogsToD1...');
		const list = await env.KV.list({ prefix: 'mail_audit_log:', limit: 500 });
		if (!list.keys || list.keys.length === 0) {
			console.log('No pending audit logs in KV to archive.');
			return;
		}

		const entries: { key: string; log: MailAuditLogEntry }[] = [];
		for (const k of list.keys) {
			const val = await env.KV.get(k.name);
			if (val) {
				try {
					const parsed = JSON.parse(val) as MailAuditLogEntry;
					entries.push({ key: k.name, log: parsed });
				} catch (err) {
					console.error(`Invalid JSON in audit log key ${k.name}:`, err);
				}
			}
		}

		if (entries.length === 0) return;

		// 批量插入 D1 数据库 (通过 D1 batch 事务批量执行)
		const statements = entries.map(({ log }) => {
			return env.DB.prepare(
				`INSERT INTO mail_logs (message_id, source, address, subject, action, forwarded_to, fingerprint, reason, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				log.message_id,
				log.source,
				log.address,
				log.subject,
				log.action,
				JSON.stringify(log.forwarded_to || []),
				log.fingerprint || null,
				log.reason || null,
				log.created_at || new Date().toISOString(),
			);
		});

		await env.DB.batch(statements);
		console.log(`Successfully archived ${entries.length} mail audit logs to D1.`);

		// 归档成功后清理对应的 KV 暂存键
		for (const { key } of entries) {
			await env.KV.delete(key);
		}
	} catch (e) {
		console.error('archiveMailAuditLogsToD1 failed:', e);
	}
}

/**
 * 清理 D1 中超过 1 年（365 天）的历史审计日志
 */
async function cleanupOldMailLogs(env: Bindings): Promise<void> {
	if (!env.DB) return;
	try {
		const res = await env.DB.prepare(`DELETE FROM mail_logs WHERE created_at < datetime('now', '-365 days');`).run();
		if (res.meta?.changes && res.meta.changes > 0) {
			console.log(`Cleaned up ${res.meta.changes} expired mail audit logs (> 1 year) from D1.`);
		}
	} catch (e) {
		console.error('cleanupOldMailLogs failed:', e);
	}
}

export async function scheduled(event: ScheduledEvent, env: Bindings, ctx: any) {
	console.log('Scheduled event: ', event);
	const autoCleanupSetting = await getJsonSetting<CleanupSettings>({ env: env } as Context<HonoCustomType>, CONSTANTS.AUTO_CLEANUP_KEY);
	if (!autoCleanupSetting) {
		console.log('No auto cleanup settings found, skipping cleanup.');
		return;
	}
	console.log('autoCleanupSetting:', JSON.stringify(autoCleanupSetting));
	if (autoCleanupSetting.enableMailsAutoCleanup) {
		await cleanup({ env: env } as Context<HonoCustomType>, 'mails', autoCleanupSetting.cleanMailsDays);
	}
	if (autoCleanupSetting.enableUnknowMailsAutoCleanup) {
		await cleanup({ env: env } as Context<HonoCustomType>, 'mails_unknow', autoCleanupSetting.cleanUnknowMailsDays);
	}
	if (autoCleanupSetting.enableSendBoxAutoCleanup) {
		await cleanup({ env: env } as Context<HonoCustomType>, 'sendbox', autoCleanupSetting.cleanSendBoxDays);
	}
	if (autoCleanupSetting.enableInactiveAddressAutoCleanup) {
		await cleanup({ env: env } as Context<HonoCustomType>, 'inactiveAddress', autoCleanupSetting.cleanInactiveAddressDays);
	}
	if (autoCleanupSetting.enableAddressAutoCleanup) {
		await cleanup({ env: env } as Context<HonoCustomType>, 'addressCreated', autoCleanupSetting.cleanAddressDays);
	}
	if (autoCleanupSetting.enableUnboundAddressAutoCleanup) {
		await cleanup({ env: env } as Context<HonoCustomType>, 'unboundAddress', autoCleanupSetting.cleanUnboundAddressDays);
	}
	if (autoCleanupSetting.enableEmptyAddressAutoCleanup) {
		await cleanup({ env: env } as Context<HonoCustomType>, 'emptyAddress', autoCleanupSetting.cleanEmptyAddressDays);
	}
	// Execute custom SQL cleanup tasks
	if (autoCleanupSetting.customSqlCleanupList && autoCleanupSetting.customSqlCleanupList.length > 0) {
		for (const customSql of autoCleanupSetting.customSqlCleanupList) {
			if (customSql.enabled && customSql.sql) {
				const result = await executeCustomSqlCleanup({ env: env } as Context<HonoCustomType>, customSql);
				if (!result.success) {
					console.error(`Custom SQL cleanup [${customSql.name}] failed: ${result.error}`);
				}
			}
		}
	}

	// 批量归档 KV 暂存日志至 D1 数据库并清理 KV
	await archiveMailAuditLogsToD1(env);

	// 清理 D1 中超过 1 年的旧审计日志
	await cleanupOldMailLogs(env);
}
