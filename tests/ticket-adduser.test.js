const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const ticketUtils = require('../src/ticket-utils.js');
const { commands } = require('../src/deploy-commands.js');

test('Deploy Commands: /add-user slash command is registered', () => {
    const addUserCmd = commands.find(c => c.name === 'add-user');
    assert.ok(addUserCmd, '/add-user command must be defined');
    assert.strictEqual(addUserCmd.options.length, 1);
    assert.strictEqual(addUserCmd.options[0].name, 'user');
    assert.strictEqual(addUserCmd.options[0].required, true);
});

test('Ticket Detection: Works for all LAX ticket types and rejects non-tickets', () => {
    // 1. Generic ticket types by topic
    const buyTicket = { type: ChannelType.GuildText, topic: 'ticket:buy_tokens:12345', name: 'buy-tokens-alice' };
    const registerTicket = { type: ChannelType.GuildText, topic: 'ticket:register_company:12345', name: 'register-company-bob' };
    const cashoutTicket = { type: ChannelType.GuildText, topic: 'ticket:cashout:12345', name: 'cashout-charlie' };
    const contactTicket = { type: ChannelType.GuildText, topic: 'ticket:contact_us:12345', name: 'contact-us-david' };

    assert.strictEqual(ticketUtils.isTicketChannel(buyTicket), true, 'buy_tokens ticket should be valid');
    assert.strictEqual(ticketUtils.isTicketChannel(registerTicket), true, 'register_company ticket should be valid');
    assert.strictEqual(ticketUtils.isTicketChannel(cashoutTicket), true, 'cashout ticket should be valid');
    assert.strictEqual(ticketUtils.isTicketChannel(contactTicket), true, 'contact_us ticket should be valid');

    // 2. Ticket in Category
    const categoryTicket = {
        type: ChannelType.GuildText,
        parent: { name: ticketUtils.TICKET_CATEGORY_NAME },
        name: 'custom-ticket-channel',
    };
    assert.strictEqual(ticketUtils.isTicketChannel(categoryTicket), true);

    // 3. Non-ticket channels
    const generalChannel = { type: ChannelType.GuildText, topic: 'General discussion', name: 'general' };
    const voiceChannel = { type: ChannelType.GuildVoice, name: 'voice-room' };

    assert.strictEqual(ticketUtils.isTicketChannel(generalChannel), false, 'General channel must NOT be a ticket');
    assert.strictEqual(ticketUtils.isTicketChannel(voiceChannel), false, 'Voice channel must NOT be a ticket');
    assert.strictEqual(ticketUtils.isTicketChannel(null), false, 'Null channel must be rejected');
});

test('Authorization: Staff roles and Admins are authorized, regular members are rejected', () => {
    // 1. Admin member
    const adminInteraction = {
        inGuild: () => true,
        member: {
            permissions: { has: (perm) => perm === PermissionFlagsBits.Administrator },
            roles: { cache: [] },
        },
    };
    assert.strictEqual(ticketUtils.isAuthorizedStaff(adminInteraction), true);

    // 2. Owner role member
    const ownerInteraction = {
        inGuild: () => true,
        member: {
            permissions: { has: () => false },
            roles: { cache: [{ id: ticketUtils.OWNER_ROLE_ID }] },
        },
    };
    assert.strictEqual(ticketUtils.isAuthorizedStaff(ownerInteraction), true);

    // 3. Representative role member
    const repInteraction = {
        inGuild: () => true,
        member: {
            permissions: { has: () => false },
            roles: { cache: [{ id: ticketUtils.REPRESENTATIVE_ROLE_ID }] },
        },
    };
    assert.strictEqual(ticketUtils.isAuthorizedStaff(repInteraction), true);

    // 4. Regular member (no staff roles or admin)
    const normalInteraction = {
        inGuild: () => true,
        member: {
            permissions: { has: () => false },
            roles: { cache: [{ id: '9999999999' }] },
        },
    };
    assert.strictEqual(ticketUtils.isAuthorizedStaff(normalInteraction), false);

    // 5. DM interaction (not in guild)
    const dmInteraction = {
        inGuild: () => false,
        member: null,
    };
    assert.strictEqual(ticketUtils.isAuthorizedStaff(dmInteraction), false);
});

test('Permission Updates: Authorized staff can add a user, preserving existing permissions and handling already-added users', async () => {
    const permissionsEdited = [];
    const cacheMap = new Map();

    const mockChannel = {
        id: 'channel_101',
        name: 'buy-tokens-user1',
        type: ChannelType.GuildText,
        topic: 'ticket:buy_tokens:user1',
        permissionOverwrites: {
            cache: cacheMap,
            async edit(targetId, permissions, options) {
                permissionsEdited.push({ targetId, permissions, options });
                cacheMap.set(targetId, {
                    id: targetId,
                    allow: {
                        has: (bit) => bit === PermissionFlagsBits.ViewChannel,
                    },
                });
            },
        },
    };

    const targetUser = { id: 'user_target_456', username: 'NewCollaborator' };
    const executorUser = { id: 'admin_123', username: 'AdminStaff' };

    // 1. Add new user to ticket
    const result1 = await ticketUtils.addUserToTicket({
        channel: mockChannel,
        targetUser,
        executorUser,
    });

    assert.strictEqual(result1.success, true);
    assert.strictEqual(result1.alreadyPresent, false);
    assert.strictEqual(permissionsEdited.length, 1);
    assert.strictEqual(permissionsEdited[0].targetId, 'user_target_456');
    assert.strictEqual(permissionsEdited[0].permissions.ViewChannel, true);
    assert.strictEqual(permissionsEdited[0].permissions.SendMessages, true);
    assert.strictEqual(permissionsEdited[0].permissions.ReadMessageHistory, true);

    // 2. Add same user again -> Safe handle without duplicate overwrites
    const result2 = await ticketUtils.addUserToTicket({
        channel: mockChannel,
        targetUser,
        executorUser,
    });

    assert.strictEqual(result2.success, true);
    assert.strictEqual(result2.alreadyPresent, true);
    assert.strictEqual(permissionsEdited.length, 1); // No additional permission edit called
});

test('Error Handling: Rejects outside ticket channel and handles API failures gracefully', async () => {
    const nonTicketChannel = {
        id: 'chan_general',
        name: 'general',
        type: ChannelType.GuildText,
        topic: 'General chat',
    };

    const targetUser = { id: 'user_xyz', username: 'TestUser' };

    // Outside ticket
    const rejectOutside = await ticketUtils.addUserToTicket({
        channel: nonTicketChannel,
        targetUser,
    });
    assert.strictEqual(rejectOutside.success, false);
    assert.ok(rejectOutside.error.includes('active ticket channel'));

    // Discord API error simulation
    const failingChannel = {
        id: 'chan_ticket_error',
        name: 'cashout-test',
        type: ChannelType.GuildText,
        topic: 'ticket:cashout:test',
        permissionOverwrites: {
            cache: new Map(),
            async edit() {
                throw new Error('Discord API 50001: Missing Permissions');
            },
        },
    };

    const apiErrorResult = await ticketUtils.addUserToTicket({
        channel: failingChannel,
        targetUser,
    });
    assert.strictEqual(apiErrorResult.success, false);
    assert.ok(apiErrorResult.error.includes('Missing Permissions'));
});
