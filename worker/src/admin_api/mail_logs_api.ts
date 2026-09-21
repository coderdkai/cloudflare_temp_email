import { Context } from 'hono';
import type { MailAuditLogEntry } from '../email/audit_log';

/**
 * GET /admin/mail_logs
 * 查询邮件流转审计日志（包含 KV 实时暂存和 D1 历史归档）
 * Query 参数:
 * - limit: 每页数量 (默认 50，最大 100)
 * - offset: 偏移量 (默认 0)
 * - action: 动作筛选 (FORWARDED / DEDUP_SKIPPED / JUNK_REJECTED / TRANSACTION_FORWARD 等)
 * - address: 临时收信邮箱 (精确或模糊匹配)
 * - source: 发件人邮箱 (模糊匹配)
 * - subject: 主题关键词 (模糊匹配)
 */
export async function getMailLogs(c: Context<HonoCustomType>): Promise<Response> {
	const limitQuery = c.req.query('limit');
	const offsetQuery = c.req.query('offset');
	const action = c.req.query('action')?.trim();
	const address = c.req.query('address')?.trim();
	const source = c.req.query('source')?.trim();
	const subject = c.req.query('subject')?.trim();

	const limit = Math.min(Math.max(parseInt(limitQuery || '50', 10) || 50, 1), 100);
	const offset = Math.max(parseInt(offsetQuery || '0', 10) || 0, 0);

	// 1. 先读取 KV 中未归档的实时日志 (仅在第一页或前几页合并)
	const pendingKvLogs: MailAuditLogEntry[] = [];
	if (c.env.KV && offset < 100) {
		try {
			const list = await c.env.KV.list({ prefix: 'mail_audit_log:', limit: 100 });
			for (const key of list.keys) {
				const val = await c.env.KV.get(key.name);
				if (val) {
					try {
						const item = JSON.parse(val) as MailAuditLogEntry;
						// 内存过滤条件
						if (action && item.action.toLowerCase() !== action.toLowerCase()) continue;
						if (address && !item.address.toLowerCase().includes(address.toLowerCase())) continue;
						if (source && !item.source.toLowerCase().includes(source.toLowerCase())) continue;
						if (subject && item.subject && !item.subject.toLowerCase().includes(subject.toLowerCase())) continue;
						pendingKvLogs.push(item);
					} catch {
						// skip invalid item
					}
				}
			}
			// 按时间降序排序
			pendingKvLogs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
		} catch (err) {
			console.error('Failed reading pending logs from KV:', err);
		}
	}

	// 2. 从 D1 数据库查询已归档的日志
	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (action) {
		conditions.push('action = ?');
		params.push(action);
	}
	if (address) {
		conditions.push('address LIKE ?');
		params.push(`%${address}%`);
	}
	if (source) {
		conditions.push('source LIKE ?');
		params.push(`%${source}%`);
	}
	if (subject) {
		conditions.push('subject LIKE ?');
		params.push(`%${subject}%`);
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const countSql = `SELECT count(*) as total FROM mail_logs ${whereClause}`;
	const dataSql = `SELECT id, message_id, source, address, subject, action, forwarded_to, fingerprint, reason, created_at FROM mail_logs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`;

	let d1Total = 0;
	let d1Rows: any[] = [];

	if (c.env.DB) {
		try {
			const countRes = await c.env.DB.prepare(countSql)
				.bind(...params)
				.first<{ total: number }>();
			d1Total = countRes?.total || 0;

			const dataRes = await c.env.DB.prepare(dataSql)
				.bind(...params, limit, offset)
				.all();
			d1Rows = (dataRes.results || []).map((row: any) => {
				let forwardedTo = [];
				try {
					forwardedTo = row.forwarded_to ? JSON.parse(row.forwarded_to) : [];
				} catch {
					forwardedTo = row.forwarded_to ? [row.forwarded_to] : [];
				}
				return {
					...row,
					forwarded_to: forwardedTo,
					is_pending_archive: false,
				};
			});
		} catch (dbErr) {
			console.error('Failed querying D1 mail_logs:', dbErr);
		}
	}

	// 合并返回（前置插入 KV 中未归档的条目）
	const kvFormatted = pendingKvLogs.slice(offset, offset + limit).map((k) => ({
		...k,
		is_pending_archive: true,
	}));

	return c.json({
		total: d1Total + pendingKvLogs.length,
		pending_in_kv: pendingKvLogs.length,
		results: [...kvFormatted, ...d1Rows].slice(0, limit),
	});
}
