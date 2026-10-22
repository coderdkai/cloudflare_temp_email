import { Context } from 'hono'

import { commonParseMail } from '../common'
import { extractUnsubscribeTarget, UnsubscribeTarget } from '../email/unsubscribe'
import { resolveRawEmailRow } from '../gzip'
import type { RawMailRow } from '../models'

export const findUnsubscribeTarget = async (
    row: RawMailRow | null | undefined
): Promise<UnsubscribeTarget | null> => {
    if (!row) return null;
    const { raw } = await resolveRawEmailRow(row);
    const parsed = await commonParseMail({ rawEmail: raw });
    if (!parsed) return null;
    return extractUnsubscribeTarget(parsed.headers, parsed.html, parsed.text);
}

export const respondUnsubscribeInfo = async (
    c: Context<HonoCustomType>, row: RawMailRow | null | undefined
) => {
    // 缺记录与“没有退订方式”要区分：前者让前端继续换另一套鉴权
    if (!row) return c.json({ error: 'mail_not_found' }, 404);
    const target = await findUnsubscribeTarget(row);
    if (!target) return c.json({ available: false });
    return c.json({
        available: true,
        url: target.url ?? '',
        mailto: target.mailto ?? '',
        oneClick: target.oneClick,
    });
}

export const respondUnsubscribe = async (
    c: Context<HonoCustomType>, row: RawMailRow | null | undefined
) => {
    const target = await findUnsubscribeTarget(row);
    if (!target?.url) {
        return c.json({ success: false, reason: 'no_unsubscribe_url' }, 404);
    }

    try {
        // 与 webhook 一致，直接请求发件人给出的地址；RFC 8058 支持一键退订时用 POST，否则退化为浏览器式 GET
        const response = await fetch(target.url, target.oneClick
            ? {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'List-Unsubscribe=One-Click',
            }
            : { method: 'GET' }
        );
        console.log(`Unsubscribe ${target.oneClick ? 'one-click POST' : 'GET'} ${response.status} for mail ${c.req.param('mail_id')}`);
        return c.json({ success: response.ok, status: response.status, oneClick: target.oneClick });
    } catch (error) {
        console.error('Unsubscribe request failed', error);
        return c.json({ success: false, reason: 'request_failed' }, 502);
    }
}

const loadAddressMailRow = async (c: Context<HonoCustomType>): Promise<RawMailRow | null> => {
    const { address } = c.get("jwtPayload");
    if (!address) return null;
    const { mail_id } = c.req.param();
    return await c.env.DB.prepare(
        `SELECT * FROM raw_mails where id = ? and address = ?`
    ).bind(mail_id, address).first<RawMailRow>();
}

const getUnsubscribe = async (c: Context<HonoCustomType>) => {
    return await respondUnsubscribeInfo(c, await loadAddressMailRow(c));
}

const unsubscribe = async (c: Context<HonoCustomType>) => {
    return await respondUnsubscribe(c, await loadAddressMailRow(c));
}

export default { getUnsubscribe, unsubscribe };
