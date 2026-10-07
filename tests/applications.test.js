const test = require('node:test');
const assert = require('node:assert/strict');
const applications = require('../src/applications.js');
const { commands } = require('../src/deploy-commands.js');

// Mock in-memory database
function createMockDb() {
    const settings = new Map();
    const applicationsList = [];

    return {
        prepare: (sql) => {
            return {
                run: async (...params) => {
                    if (sql.includes('CREATE TABLE')) return { changes: 0 };

                    if (sql.includes('INSERT INTO application_settings')) {
                        const key = params[0];
                        const value = params[1];
                        const updated_at = params[2];
                        settings.set(key, { key, value, updated_at });
                        return { changes: 1 };
                    }

                    if (sql.includes('INSERT INTO applications')) {
                        const [user_id, username, answers_json, created_at] = params;
                        const id = applicationsList.length + 1;
                        applicationsList.push({ id, user_id, username, status: 'pending', answers_json, created_at });
                        return { lastInsertRowid: id, changes: 1 };
                    }

                    return { changes: 0 };
                },
                get: async (...params) => {
                    if (sql.includes('FROM application_settings WHERE key = ?')) {
                        const key = params[0];
                        return settings.get(key) || null;
                    }
                    if (sql.includes('FROM applications WHERE user_id = ? AND status = ?')) {
                        const [user_id, status] = params;
                        return applicationsList.find(a => a.user_id === user_id && a.status === status) || null;
                    }
                    return null;
                },
                all: async () => {
                    if (sql.includes('FROM applications')) return applicationsList;
                    return [];
                },
            };
        },
    };
}

test('Deploy Commands: /application slash command is registered as admin-only with open/close choices', () => {
    const cmd = commands.find(c => c.name === 'application');
    assert.ok(cmd, '/application command must be registered');
    assert.strictEqual(cmd.default_member_permissions, '8', 'Must require Administrator permission (8)');

    const statusOpt = cmd.options.find(o => o.name === 'status');
    assert.ok(statusOpt, 'status option must exist');
    assert.strictEqual(statusOpt.required, true);
    assert.strictEqual(statusOpt.choices.length, 2);
    assert.ok(statusOpt.choices.some(c => c.value === 'open'));
    assert.ok(statusOpt.choices.some(c => c.value === 'close'));

    const channelOpt = cmd.options.find(o => o.name === 'channel');
    assert.ok(channelOpt, 'channel option should exist');
});

test('Application Settings: Correctly sets and retrieves open/close status and timestamps', async () => {
    const db = createMockDb();

    // Default status when uninitialized
    const initial = await applications.getApplicationStatus(db);
    assert.strictEqual(initial.isOpen, false);
    assert.strictEqual(initial.status, 'closed');

    // Open applications
    const openRes = await applications.setApplicationStatus(db, 'open');
    assert.strictEqual(openRes.status, 'open');

    const openStatus = await applications.getApplicationStatus(db);
    assert.strictEqual(openStatus.isOpen, true);
    assert.strictEqual(openStatus.status, 'open');
    assert.ok(openStatus.reopenedAt > 0);

    // Close applications
    const closeRes = await applications.setApplicationStatus(db, 'close');
    assert.strictEqual(closeRes.status, 'closed');

    const closeStatus = await applications.getApplicationStatus(db);
    assert.strictEqual(closeStatus.isOpen, false);
    assert.strictEqual(closeStatus.status, 'closed');
    assert.ok(closeStatus.closedAt > 0);
});

test('Application Panel: Generates rich embed and "Apply for Representative" button', () => {
    const payload = applications.createApplicationPanelPayload();
    assert.ok(payload.embeds && payload.embeds.length > 0);
    assert.ok(payload.embeds[0].title.includes('LAX Representative'));

    assert.ok(payload.components && payload.components.length > 0);
    const button = payload.components[0].components[0].data;
    assert.strictEqual(button.custom_id, 'app:apply_rep');
    assert.strictEqual(button.label, 'Apply for Representative');
});

test('Apply Button: When closed, informs user with closed timestamp and redo instruction', async () => {
    const db = createMockDb();
    await applications.setApplicationStatus(db, 'close');

    let replyPayload = null;
    const mockInteraction = {
        user: { id: 'user_123', username: 'ApplicantUser' },
        reply: async (payload) => {
            replyPayload = payload;
            return payload;
        },
    };

    await applications.handleApplyButton(mockInteraction, db);
    assert.ok(replyPayload);
    assert.ok(replyPayload.content.includes('Applications are closed as of'));
    assert.ok(replyPayload.content.includes('redo') || replyPayload.content.includes('reopen') || replyPayload.content.includes('/application'));
});

test('Apply Button: When open, sends DM to start application questionnaire', async () => {
    const db = createMockDb();
    await applications.setApplicationStatus(db, 'open');

    let dmSent = null;
    let interactionReplied = null;

    const mockInteraction = {
        user: {
            id: 'user_applicant_777',
            username: 'GoodCandidate',
            createDM: async () => ({
                send: async (msg) => {
                    dmSent = msg;
                    return msg;
                },
            }),
        },
        channelId: 'chan_general',
        guildId: 'guild_lax',
        reply: async (payload) => {
            interactionReplied = payload;
            return payload;
        },
    };

    await applications.handleApplyButton(mockInteraction, db);
    assert.ok(interactionReplied);
    assert.ok(interactionReplied.content.includes('Direct Messages'));
    assert.ok(dmSent);
    assert.ok(dmSent.embeds[0].title.includes('LAX Representative Application'));
    assert.ok(dmSent.embeds[0].description.includes('Question 1'));
    assert.ok(applications.activeSessions.has('user_applicant_777'));

    // Clean up session
    applications.activeSessions.delete('user_applicant_777');
});

test('Apply Button: Handles user with closed DMs gracefully', async () => {
    const db = createMockDb();
    await applications.setApplicationStatus(db, 'open');

    let interactionReplied = null;
    const mockInteraction = {
        user: {
            id: 'user_closed_dms',
            username: 'PrivateUser',
            createDM: async () => {
                throw new Error('DiscordAPIError[50007]: Cannot send messages to this user');
            },
        },
        reply: async (payload) => {
            interactionReplied = payload;
            return payload;
        },
    };

    await applications.handleApplyButton(mockInteraction, db);
    assert.ok(interactionReplied);
    assert.ok(interactionReplied.content.includes('Could not send you a Direct Message'));
    assert.ok(interactionReplied.content.includes('Privacy & Safety'));
});

test('DM Questionnaire: Walks through all questions and submits application to database & staff review', async () => {
    const db = createMockDb();
    await applications.setApplicationStatus(db, 'open');

    const userId = 'user_applicant_999';
    const username = 'EagerApplicant';

    // Start session
    applications.activeSessions.set(userId, {
        userId,
        username,
        step: 0,
        answers: [],
        guildId: 'guild_1',
        channelId: 'chan_app',
        startedAt: Date.now(),
    });

    const mockClient = {
        channels: {
            fetch: async () => ({
                send: async () => {},
            }),
        },
    };

    const answersList = [
        'Discord: @EagerApplicant | Roblox: RobloxUser123',
        'EST, available 5 hours daily on evenings/weekends',
        'Yes, 2 years experience with token exchanges and ticket systems',
        'I am dedicated, reliable, and want to support the LAX community',
        'Yes, I understand and agree to all rules and investigations if violated',
    ];

    // Answer questions 1 through 5
    for (let i = 0; i < answersList.length; i++) {
        let dmReply = null;
        const msg = {
            guild: null,
            author: { bot: false, id: userId, username },
            content: answersList[i],
            reply: async (payload) => {
                dmReply = payload;
                return payload;
            },
        };

        const handled = await applications.handleDirectMessage(msg, mockClient, db);
        assert.strictEqual(handled, true, `Question ${i + 1} should be handled`);

        if (i < answersList.length - 1) {
            assert.ok(dmReply.embeds[0].title.includes(`Question ${i + 2}`));
        } else {
            // Final submission
            assert.ok(dmReply.embeds[0].title.includes('Application Submitted Successfully'));
        }
    }

    // Session should be cleared after completion
    assert.strictEqual(applications.activeSessions.has(userId), false);

    // Database should now have the application record
    const allApps = await db.prepare('SELECT * FROM applications').all();
    assert.strictEqual(allApps.length, 1);
    assert.strictEqual(allApps[0].user_id, userId);
    assert.strictEqual(allApps[0].status, 'pending');

    const parsedAnswers = JSON.parse(allApps[0].answers_json);
    assert.strictEqual(parsedAnswers.length, 5);
    assert.strictEqual(parsedAnswers[0].answer, answersList[0]);
    assert.strictEqual(parsedAnswers[4].answer, answersList[4]);
});

test('DM Questionnaire: Cancel command aborts session without submitting', async () => {
    const db = createMockDb();
    const userId = 'user_cancel_123';

    applications.activeSessions.set(userId, {
        userId,
        username: 'IndecisiveUser',
        step: 1,
        answers: [{ id: 'availability', title: 'Availability', answer: 'PST' }],
        guildId: 'guild_1',
        channelId: 'chan_app',
        startedAt: Date.now(),
    });

    let dmReply = null;
    const msg = {
        guild: null,
        author: { bot: false, id: userId },
        content: 'cancel',
        reply: async (payload) => {
            dmReply = payload;
            return payload;
        },
    };

    const handled = await applications.handleDirectMessage(msg, null, db);
    assert.strictEqual(handled, true);
    assert.ok(dmReply.embeds[0].title.includes('Application Cancelled'));
    assert.strictEqual(applications.activeSessions.has(userId), false);

    // Ensure nothing was saved in DB
    const allApps = await db.prepare('SELECT * FROM applications').all();
    assert.strictEqual(allApps.length, 0);
});

test('Configured Channel & Role IDs: Defaults match server specification', () => {
    assert.strictEqual(applications.DEFAULT_APPLICATION_CHANNEL_ID, '1556655282027757688');
    assert.strictEqual(applications.DEFAULT_APPLICATIONS_REVIEW_CHANNEL_ID, '1557379354114138113');
    assert.strictEqual(applications.COMPANY_OWNER_ROLE_ID, '1554769304589832284');
    assert.strictEqual(applications.REPRESENTATIVE_ROLE_ID, '1543952151364116490');
});

test('Staff Review: Accept button assigns Representative role and notifies applicant in DM', async () => {
    const db = createMockDb();
    const appRes = await db.prepare('INSERT INTO applications').run('applicant_007', 'SuperStar', JSON.stringify([]), Date.now());
    const appId = appRes.lastInsertRowid;

    let roleAssigned = false;
    let dmSentToUser = null;
    let messageEdited = null;

    const mockGuild = {
        roles: {
            cache: new Map([
                ['1543952151364116490', { id: '1543952151364116490', name: 'Representative' }],
            ]),
            fetch: async () => ({ id: '1543952151364116490', name: 'Representative' }),
        },
        members: {
            fetch: async () => ({
                roles: {
                    cache: new Map(),
                    add: async (roleId) => {
                        if (roleId === '1543952151364116490') roleAssigned = true;
                    },
                },
            }),
        },
    };

    const mockClient = {
        users: {
            fetch: async (uid) => ({
                id: uid,
                send: async (msg) => {
                    dmSentToUser = msg;
                    return msg;
                },
            }),
        },
    };

    const mockInteraction = {
        customId: `app:review:accept:${appId}:applicant_007`,
        inGuild: () => true,
        guild: mockGuild,
        member: {
            permissions: { has: () => true },
            roles: { cache: new Map() },
        },
        user: { id: 'staff_123', username: 'HeadAdmin', tag: 'HeadAdmin#0001' },
        message: {
            content: 'Review notification',
            embeds: [{ data: { title: 'App' } }],
            edit: async (payload) => {
                messageEdited = payload;
                return payload;
            },
        },
        deferUpdate: async () => {},
    };

    await applications.handleReviewButton(mockInteraction, db, mockClient);

    assert.strictEqual(roleAssigned, true, 'Representative role must be assigned upon approval');
    assert.ok(dmSentToUser, 'Applicant must receive acceptance DM');
    assert.ok(dmSentToUser.embeds[0].title.includes('Application Accepted'));
    assert.ok(messageEdited.embeds[0].description.includes('Accepted'));
});

