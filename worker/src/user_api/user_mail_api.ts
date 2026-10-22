import { Context } from "hono";
import i18n from "../i18n";
import { handleMailListQuery } from "../common";
import { getBooleanValue } from "../utils";
import { respondUnsubscribe, respondUnsubscribeInfo } from "../mails_api/unsubscribe_api";
import type { RawMailRow } from "../models";

const loadUserMailRow = async (c: Context<HonoCustomType>): Promise<RawMailRow | null> => {
    const { user_id } = c.get("userPayload");
    const { mail_id } = c.req.param();
    return await c.env.DB.prepare(
        `SELECT rm.* FROM raw_mails rm`
        + ` WHERE rm.id = ?`
        + ` AND EXISTS (`
        + `SELECT 1 FROM users_address ua`
        + ` JOIN address a ON a.id = ua.address_id`
        + ` WHERE ua.user_id = ? AND a.name = rm.address`
        + `)`
    ).bind(mail_id, user_id).first<RawMailRow>();
}

export default {
    getMails: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { address, limit, offset } = c.req.query();
        const filterQuerys = [`ua.user_id = ?`];
        const filterParams = [String(user_id)];
        if (address) {
            filterQuerys.push(`rm.address = ?`);
            filterParams.push(address);
        }
        const fromQuery = ` FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` JOIN raw_mails rm ON rm.address = a.name`
            + ` WHERE ${filterQuerys.join(" AND ")}`;
        return await handleMailListQuery(c,
            `SELECT rm.*${fromQuery}`,
            `SELECT count(*) as count${fromQuery}`,
            filterParams, limit, offset, 'rm.id desc'
        );
    },
    deleteMail: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
            return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
        }
        const { id } = c.req.param();
        const { user_id } = c.get("userPayload");
        const { success } = await c.env.DB.prepare(
            `DELETE FROM raw_mails WHERE id = ?`
            + ` AND EXISTS (`
            + `SELECT 1 FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` WHERE ua.user_id = ? AND a.name = raw_mails.address`
            + `)`
        ).bind(id, user_id).run();
        return c.json({
            success: success
        })
    },
    getUnsubscribe: async (c: Context<HonoCustomType>) => {
        return await respondUnsubscribeInfo(c, await loadUserMailRow(c));
    },
    unsubscribe: async (c: Context<HonoCustomType>) => {
        return await respondUnsubscribe(c, await loadUserMailRow(c));
    }
}
