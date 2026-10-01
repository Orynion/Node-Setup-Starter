const { PermissionFlagsBits, ChannelType } = require('discord.js');

const TICKET_CATEGORY_NAME = '「📩」Contact Us------------------';
const OWNER_ROLE_ID = '1478001619030511747';
const REPRESENTATIVE_ROLE_ID = '1543952151364116490';

/**
 * Checks whether a given Discord interaction is from an Administrator.
 */
function isAuthorizedStaff(interaction) {
    if (!interaction.inGuild()) return false;
    const member = interaction.member;
    if (!member) return false;

    return Boolean(member.permissions?.has(PermissionFlagsBits.Administrator));
}

/**
 * Checks whether a Discord channel is a valid LAX ticket channel.
 * Works for all ticket types: buy_tokens, register_company, cashout, contact_us, etc.
 */
function isTicketChannel(channel) {
    if (!channel || channel.type !== ChannelType.GuildText) {
        return false;
    }

    // 1. Topic check (standard across all LAX ticket types: ticket:<type>:<userId>)
    if (typeof channel.topic === 'string' && channel.topic.startsWith('ticket:')) {
        return true;
    }

    // 2. Category check
    if (channel.parent?.name === TICKET_CATEGORY_NAME) {
        return true;
    }

    // 3. Name slug check for fallback compatibility
    const ticketSlugs = ['buy-tokens-', 'register-company-', 'cashout-', 'contact-us-'];
    if (ticketSlugs.some(slug => channel.name?.toLowerCase().startsWith(slug))) {
        return true;
    }

    return false;
}

/**
 * Adds a user to a private ticket channel safely:
 * - Does not modify or remove existing permissions.
 * - Does not open permissions to @everyone.
 * - Checks if user already has access.
 */
async function addUserToTicket({ channel, targetUser, executorUser }) {
    if (!channel || !isTicketChannel(channel)) {
        return {
            success: false,
            error: 'This command can only be used inside an active ticket channel.',
        };
    }

    if (!targetUser || !targetUser.id) {
        return {
            success: false,
            error: 'Invalid target user specified.',
        };
    }

    // Check if user already has ViewChannel permission
    const existingOverwrite = channel.permissionOverwrites?.cache?.get(targetUser.id);
    if (existingOverwrite) {
        const allowed = typeof existingOverwrite.allow?.has === 'function'
            ? existingOverwrite.allow.has(PermissionFlagsBits.ViewChannel)
            : Boolean(existingOverwrite.allow & PermissionFlagsBits.ViewChannel);

        if (allowed) {
            return {
                success: true,
                alreadyPresent: true,
                targetUserId: targetUser.id,
                channelId: channel.id,
            };
        }
    }

    try {
        await channel.permissionOverwrites.edit(targetUser.id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true,
        }, {
            reason: `User added to ticket by ${executorUser ? `${executorUser.username} (${executorUser.id})` : 'staff'}`,
        });

        console.log(`[Ticket Staff] User ${executorUser?.id} (${executorUser?.username}) added ${targetUser.id} (${targetUser.username}) to ticket ${channel.name} (${channel.id}).`);

        return {
            success: true,
            alreadyPresent: false,
            targetUserId: targetUser.id,
            channelId: channel.id,
        };
    } catch (err) {
        console.error(`[Ticket Staff] Failed to add user ${targetUser.id} to ticket ${channel.id}:`, err);
        return {
            success: false,
            error: `Failed to update ticket permissions: ${err.message}`,
        };
    }
}

module.exports = {
    TICKET_CATEGORY_NAME,
    OWNER_ROLE_ID,
    REPRESENTATIVE_ROLE_ID,
    isAuthorizedStaff,
    isTicketChannel,
    addUserToTicket,
};
