/**
 * Automatic unsubscribe for marketing mail.
 *
 * Deduplication keeps only the first copy of a campaign, so a manual button on
 * the stored mail can only unsubscribe one recipient. Real unsubscribe links are
 * per-recipient (OpenAI's carries `user_id` + token), so every address has to
 * issue its own request. This runs for every received marketing mail, before the
 * dedup early-return, and does not touch KV.
 */

import { extractEffectiveSenderDomain, getBaseDomain } from './marketing.ts'
import { extractUnsubscribeTarget } from './unsubscribe.ts'

export type AutoUnsubscribeRequest = {
	url: string
	oneClick: boolean
}

/**
 * Resolve an unsubscribe request only when the link belongs to the sender's own
 * base domain. A forged mail could otherwise make the worker fetch arbitrary hosts.
 */
export const resolveAutoUnsubscribeRequest = (
	from: string,
	headers?: Record<string, string>[] | null,
	html?: string | null,
	text?: string | null,
): AutoUnsubscribeRequest | null => {
	const target = extractUnsubscribeTarget(headers, html, text);
	if (!target?.url) return null;

	let targetDomain = '';
	try {
		targetDomain = getBaseDomain(new URL(target.url).hostname);
	} catch {
		return null;
	}

	const senderDomain = extractEffectiveSenderDomain(from, headers);
	if (!senderDomain || targetDomain !== senderDomain) return null;

	return { url: target.url, oneClick: target.oneClick };
}

/**
 * Fire the unsubscribe request. RFC 8058 senders get the one-click POST, others
 * a plain GET equivalent to opening the link in a browser.
 */
export const autoUnsubscribe = async (
	from: string,
	headers: Record<string, string>[] | null | undefined,
	html: string | null | undefined,
	text: string | null | undefined,
): Promise<void> => {
	const request = resolveAutoUnsubscribeRequest(from, headers, html, text);
	if (!request) return;

	try {
		const response = await fetch(request.url, request.oneClick
			? {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: 'List-Unsubscribe=One-Click',
			}
			: { method: 'GET' }
		);
		console.log(`Auto unsubscribe ${request.oneClick ? 'one-click POST' : 'GET'} ${response.status} from ${from}`);
	} catch (error) {
		console.error('Auto unsubscribe request failed', error);
	}
}
