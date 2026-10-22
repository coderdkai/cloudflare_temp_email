export type MailAuditAction =
	'FORWARDED' | 'DEDUP_SKIPPED' | 'JUNK_REJECTED' | 'TRANSACTION_FORWARD' | 'UNKNOWN_ADDRESS_REJECTED' | 'BLOCKED_SENDER_REJECTED';

export type MailAuditLogEntry = {
	message_id: string | null;
	source: string;
	address: string;
	subject: string | null;
	action: MailAuditAction;
	forwarded_to: string[];
	fingerprint?: string | null;
	reason?: string | null;
	created_at: string;
};

/**
 * 实时记录邮件流转审计日志到 KV 中
 * 注意：正常放行入库的邮件已完整保存在 D1 raw_mails 中，营销去重命中仅 console.log，
 * 两者均不写 KV，避免营销群发/批量注册拉爆 KV 每日 1000 次写入配额；
 * KV 审计只记录真实拦截事件（JUNK / UNKNOWN_ADDRESS / BLOCKED_SENDER）。
 * Key 格式: mail_audit_log:<timestamp_ms>:<random_suffix>
 */
export async function recordMailAuditLog(env: Bindings, entry: MailAuditLogEntry): Promise<void> {
	if (!env.KV) return;
	// 关键节流优化：正常放行与去重跳过的事件不写 KV 审计
	if (entry.action === 'FORWARDED' || entry.action === 'TRANSACTION_FORWARD' || entry.action === 'DEDUP_SKIPPED') {
		return;
	}
	try {
		const now = Date.now();
		const rand = Math.random().toString(36).substring(2, 8);
		const kvKey = `mail_audit_log:${now}:${rand}`;
		// KV 暂存保留 7 天，等待 Cron 定时任务批量落库 D1
		await env.KV.put(kvKey, JSON.stringify(entry), { expirationTtl: 604800 });
	} catch (error) {
		// 捕获所有 KV 限制错误（如 429），确保邮件入站处理永远不受影响、不中断
		console.error('recordMailAuditLog error (ignored to protect mail delivery):', error);
	}
}
