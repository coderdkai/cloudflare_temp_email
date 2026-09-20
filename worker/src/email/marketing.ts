/**
 * 提取发件人邮箱的域名
 */
function extractMailDomain(address: string | undefined | null): string {
	if (!address) return '';
	const atIndex = address.lastIndexOf('@');
	if (atIndex === -1) return address.trim().toLowerCase();
	return address
		.slice(atIndex + 1)
		.trim()
		.toLowerCase();
}

// 事务性/验证类邮件主题关键词（白名单保护：直接放行，避免误伤验证码或账单通知）
const TRANSACTIONAL_SUBJECT_KEYWORDS: readonly string[] = [
	'verification code',
	'verify your',
	'verification',
	'security code',
	'auth code',
	'confirmation code',
	'one-time password',
	'otp',
	'your code',
	'code -',
	'code challenge',
	'password reset',
	'reset your password',
	'invoice',
	'payment',
	'account suspended',
	'account termination',
	'account security',
	'验证码',
	'校验码',
	'安全码',
	'重置密码',
	'修改密码',
	'账单',
	'支付凭证',
	'扣费',
	'订单确认',
];

// 标准营销邮件请求头名称
const MARKETING_HEADER_NAMES: readonly string[] = [
	'list-unsubscribe',
	'list-unsubscribe-post',
	'feedback-id',
	'x-campaign',
	'x-campaign-id',
	'x-mc-user',
	'x-mailgun-campaign-id',
	'x-sendgrid-eid',
];

/**
 * 判断是否包含事务/验证类高优先级的关键词（白名单）
 */
export function isTransactionalEmail(subject: string | undefined | null): boolean {
	if (!subject) return false;
	const lowerSubj = subject.toLowerCase();
	return TRANSACTIONAL_SUBJECT_KEYWORDS.some((kw) => lowerSubj.includes(kw));
}

/**
 * 依据邮件头判断是否为商业/营销群发邮件
 */
export function isMarketingEmailByHeaders(headers: Record<string, string>[] | undefined | null, subject?: string | null): boolean {
	// 1. 白名单保护：若标题明确为验证码或重要事务通知，绝不判定为营销邮件
	if (isTransactionalEmail(subject)) {
		return false;
	}

	if (!headers || !Array.isArray(headers)) {
		return false;
	}

	for (const header of headers) {
		if (!header.key || !header.value) continue;
		const key = header.key.trim().toLowerCase();
		const value = header.value.trim().toLowerCase();

		// 命中标准营销/退订等标头
		if (MARKETING_HEADER_NAMES.includes(key)) {
			return true;
		}

		// 批量/列表优先级标头
		if (key === 'precedence' && (value.includes('bulk') || value.includes('list'))) {
			return true;
		}

		// 自动投递的营销摘要等
		if (key === 'x-auto-response-suppress' && value.includes('all')) {
			return true;
		}
	}

	return false;
}

/**
 * 规范化邮件正文片段，剔除收件人特定参数、动态退订链接等噪声，保留主体文本
 */
export function normalizeBodyForFingerprint(bodyText: string): string {
	if (!bodyText) return '';

	return (
		bodyText
			// 移除 URL 链接以消除个性化 token 与 tracking 参数的影响
			.replace(/https?:\/\/[^\s<>"')]+/gi, ' ')
			// 移除邮箱地址
			.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, ' ')
			// 移除连续空白与换行
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 500)
			.toLowerCase()
	);
}

/**
 * 生成营销邮件内容去重指纹 Hash (SHA-256)
 */
export async function computeMarketingFingerprint(
	from: string,
	subject: string | undefined | null,
	bodyText: string | undefined | null,
): Promise<string> {
	const senderDomain = extractMailDomain(from);
	const normalizedSubject = (subject || '').trim().toLowerCase().replace(/\s+/g, ' ');
	const normalizedBody = normalizeBodyForFingerprint(bodyText || '');

	const payload = `${senderDomain}|${normalizedSubject}|${normalizedBody}`;
	const encoder = new TextEncoder();
	const data = encoder.encode(payload);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
