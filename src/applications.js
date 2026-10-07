/**
 * LAX Representative Application Manager
 * Handles opening/closing applications, interactive DM questionnaires,
 * database storage, and staff review notifications.
 */

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    PermissionFlagsBits,
} = require('discord.js');

// Channel & Role IDs specified by server configuration
const DEFAULT_APPLICATION_CHANNEL_ID = '1556655282027757688';
const DEFAULT_APPLICATIONS_REVIEW_CHANNEL_ID = '1557379354114138113';
const REPRESENTATIVE_ROLE_ID = '1543952151364116490';
const OWNER_ROLE_ID = '1478001619030511747';
const COMPANY_OWNER_ROLE_ID = '1554769304589832284';

// Configured questions for LAX Representative application
const DEFAULT_APPLICATION_QUESTIONS = [
    {
        id: 'usernames',
        title: 'Discord & Roblox Username',
        prompt: 'Please provide your Discord username and your Roblox username.',
        placeholder: 'e.g. Discord: @username | Roblox: RobloxPlayer123',
    },
    {
        id: 'availability',
        title: 'Timezone & Availability',
        prompt: 'What is your timezone and usual availability?',
        placeholder: 'e.g. EST (UTC-5), available 4-6 hours daily on evenings/weekends',
    },
    {
        id: 'financial_experience',
        title: 'Financial & Company Experience',
        prompt: 'Do you have experience with any of these types of financial companies or exchange groups?',
        placeholder: 'Describe any past experience with token exchanges, trading, customer support, or companies',
    },
    {
        id: 'motivation',
        title: 'Why Hire You & Why Join LAX',
        prompt: 'Why should we hire you and why do you want to join us?',
        placeholder: 'Share why you want to become a Representative and the value you bring to LAX',
    },
    {
        id: 'compliance_agreement',
        title: 'Policy & Investigation Agreement',
        prompt: 'Do you understand that if you make any kind of malicious activity, an investigation can be launched against you?',
        placeholder: 'e.g. Yes, I understand and agree',
    },
];

// Active in-memory DM questionnaire sessions: userId -> Session Object
const activeSessions = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes session timeout

/**
 * Ensures required application tables exist.
 */
async function ensureTables(db) {
    if (!db) return;
    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS application_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `).run();

        await db.prepare(`
            CREATE TABLE IF NOT EXISTS applications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                username TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                answers_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                reviewed_by TEXT,
                reviewed_at INTEGER,
                review_notes TEXT
            );
        `).run();
    } catch (err) {
        console.warn('[Applications] Table initialization note:', err.message);
    }
}

/**
 * Retrieves the current application status from database or default.
 */
async function getApplicationStatus(db) {
    if (!db) return { status: 'closed', closedAt: Date.now(), reopenedAt: null };

    try {
        await ensureTables(db);
        const statusRow = await db.prepare('SELECT value, updated_at FROM application_settings WHERE key = ?').get('rep_app_status');
        const closedAtRow = await db.prepare('SELECT value FROM application_settings WHERE key = ?').get('rep_app_closed_at');
        const reopenedAtRow = await db.prepare('SELECT value FROM application_settings WHERE key = ?').get('rep_app_reopened_at');

        const status = statusRow ? statusRow.value : 'closed';
        const closedAt = closedAtRow ? parseInt(closedAtRow.value, 10) : (statusRow ? statusRow.updated_at : Date.now());
        const reopenedAt = reopenedAtRow ? parseInt(reopenedAtRow.value, 10) : null;

        return {
            status,
            isOpen: status === 'open',
            closedAt: closedAt || Date.now(),
            reopenedAt,
            updatedAt: statusRow ? statusRow.updated_at : Date.now(),
        };
    } catch (err) {
        console.error('[Applications] Error getting status:', err.message);
        return { status: 'closed', isOpen: false, closedAt: Date.now(), reopenedAt: null };
    }
}

/**
 * Updates application status to 'open' or 'closed'.
 */
async function setApplicationStatus(db, status) {
    if (!db) return;
    await ensureTables(db);

    const now = Date.now();
    const normalized = status.toLowerCase() === 'open' ? 'open' : 'closed';

    await db.prepare(`
        INSERT INTO application_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('rep_app_status', normalized, now);

    if (normalized === 'open') {
        await db.prepare(`
            INSERT INTO application_settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run('rep_app_reopened_at', String(now), now);
    } else {
        await db.prepare(`
            INSERT INTO application_settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run('rep_app_closed_at', String(now), now);
    }

    return { status: normalized, timestamp: now };
}

/**
 * Generates the application panel message payload.
 */
function createApplicationPanelPayload() {
    const embed = {
        title: '💼 LAX Representative Applications',
        description:
            'Are you interested in representing the **Los Angeles Exchange (LAX)** and helping our community grow?\n\n' +
            '**Key Responsibilities:**\n' +
            '• Assist members with exchange inquiries and token purchases\n' +
            '• Facilitate ticket support with professionalism and accuracy\n' +
            '• Maintain a helpful, trustworthy presence in our community\n\n' +
            '**How to Apply:**\n' +
            'Click the **"Apply for Representative"** button below. The bot will initiate an interactive application questionnaire directly in your **Direct Messages (DMs)**.\n\n' +
            '⚠️ *Please make sure your Direct Messages are enabled before clicking the button.*',
        color: 0x5865F2,
        footer: {
            text: 'Los Angeles Exchange • Staff Recruitment',
        },
    };

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('app:apply_rep')
            .setLabel('Apply for Representative')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📝')
    );

    return {
        embeds: [embed],
        components: [row],
    };
}

/**
 * Handles the "Apply for Representative" button interaction.
 */
async function handleApplyButton(interaction, db) {
    const appState = await getApplicationStatus(db);

    // 1. Check if applications are closed
    if (!appState.isOpen) {
        const closedTimestampSec = Math.floor((appState.closedAt || Date.now()) / 1000);
        return interaction.reply({
            content: `❌ **Applications are closed as of <t:${closedTimestampSec}:f>** (<t:${closedTimestampSec}:R>).\n\nPlease check back later or wait for an administrator to reopen applications with \`/application status:open\`.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const userId = interaction.user.id;
    const username = interaction.user.tag || interaction.user.username;

    // 2. Check if user already has an active pending application
    if (db) {
        try {
            const pending = await db.prepare('SELECT id FROM applications WHERE user_id = ? AND status = ?').get(userId, 'pending');
            if (pending) {
                return interaction.reply({
                    content: 'ℹ️ You already have a pending application under review. Our management team will process it soon.',
                    flags: MessageFlags.Ephemeral,
                });
            }
        } catch (_) {}
    }

    // 3. Check if user already has an active DM session
    if (activeSessions.has(userId)) {
        return interaction.reply({
            content: 'ℹ️ You already have an active application session in your Direct Messages! Please check your DMs or reply with `cancel` to restart.',
            flags: MessageFlags.Ephemeral,
        });
    }

    // 4. Try to initiate DM
    try {
        const firstQuestion = DEFAULT_APPLICATION_QUESTIONS[0];
        const dmChannel = await interaction.user.createDM();

        await dmChannel.send({
            embeds: [{
                title: '💼 LAX Representative Application',
                description:
                    `Hello **${interaction.user.username}**! Thank you for applying for the **LAX Representative** role.\n\n` +
                    `There are **${DEFAULT_APPLICATION_QUESTIONS.length} questions** in total. Please answer each question by typing your response directly in this DM.\n\n` +
                    `*(Type \`cancel\` at any time if you wish to abort the application)*\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `📋 **Question 1 of ${DEFAULT_APPLICATION_QUESTIONS.length}: ${firstQuestion.title}**\n\n` +
                    `**${firstQuestion.prompt}**\n\n` +
                    `*${firstQuestion.placeholder}*`,
                color: 0x5865F2,
                footer: { text: 'Type your answer below' },
            }],
        });

        // Register active session
        activeSessions.set(userId, {
            userId,
            username,
            step: 0,
            answers: [],
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            startedAt: Date.now(),
        });

        return interaction.reply({
            content: '✅ **Application started!** Please check your **Direct Messages (DMs)** to answer the questions.',
            flags: MessageFlags.Ephemeral,
        });
    } catch (dmErr) {
        console.warn(`[Applications] Failed to DM user ${userId}:`, dmErr.message);
        return interaction.reply({
            content: '❌ **Could not send you a Direct Message.**\n\nPlease enable Direct Messages from server members in your Discord **Privacy & Safety** settings, then click Apply again.',
            flags: MessageFlags.Ephemeral,
        });
    }
}

/**
 * Handles incoming DM messages from applicants.
 */
async function handleDirectMessage(message, client, db) {
    if (!message || message.guild || message.author.bot) return false;

    const userId = message.author.id;
    const session = activeSessions.get(userId);
    if (!session) return false;

    // Check timeout
    if (Date.now() - session.startedAt > SESSION_TIMEOUT_MS) {
        activeSessions.delete(userId);
        await message.reply({
            embeds: [{
                title: '⌛ Application Timed Out',
                description: 'Your application session has expired due to inactivity. You can start a new application anytime from the server application panel.',
                color: 0xED4245,
            }],
        }).catch(() => {});
        return true;
    }

    const content = (message.content || '').trim();

    // Check cancellation
    if (content.toLowerCase() === 'cancel') {
        activeSessions.delete(userId);
        await message.reply({
            embeds: [{
                title: '❌ Application Cancelled',
                description: 'Your application has been cancelled. No answers were saved. You can apply again anytime from the server application panel.',
                color: 0xED4245,
            }],
        }).catch(() => {});
        return true;
    }

    if (!content) {
        await message.reply('Please provide a text answer or type `cancel` to abort.');
        return true;
    }

    const currentQuestion = DEFAULT_APPLICATION_QUESTIONS[session.step];
    session.answers.push({
        id: currentQuestion.id,
        title: currentQuestion.title,
        question: currentQuestion.prompt,
        answer: content,
    });

    session.step++;

    // If more questions remain
    if (session.step < DEFAULT_APPLICATION_QUESTIONS.length) {
        const nextQ = DEFAULT_APPLICATION_QUESTIONS[session.step];
        await message.reply({
            embeds: [{
                title: `📋 Question ${session.step + 1} of ${DEFAULT_APPLICATION_QUESTIONS.length}: ${nextQ.title}`,
                description: `**${nextQ.prompt}**\n\n*${nextQ.placeholder}*\n\n*(Type \`cancel\` to abort)*`,
                color: 0x5865F2,
                footer: { text: `Question ${session.step + 1}/${DEFAULT_APPLICATION_QUESTIONS.length}` },
            }],
        });
        return true;
    }

    // All questions answered -> Finalize application!
    activeSessions.delete(userId);

    const now = Date.now();
    let applicationId = null;

    if (db) {
        try {
            await ensureTables(db);
            const res = await db.prepare(`
                INSERT INTO applications (user_id, username, status, answers_json, created_at)
                VALUES (?, ?, 'pending', ?, ?)
            `).run(userId, session.username, JSON.stringify(session.answers), now);
            applicationId = res.lastInsertRowid;
        } catch (dbErr) {
            console.error('[Applications] Error saving application to DB:', dbErr);
        }
    }

    // Send confirmation in DM
    await message.reply({
        embeds: [{
            title: '🎉 Application Submitted Successfully!',
            description:
                `Thank you for applying for the **LAX Representative** role!\n\n` +
                `Your application has been forwarded to the management team for review. You will receive a direct notification once a decision has been made.`,
            color: 0x57F287,
            fields: [
                { name: 'Application ID', value: `\`#${applicationId || 'APP-' + Date.now().toString().slice(-4)}\``, inline: true },
                { name: 'Submitted At', value: `<t:${Math.floor(now / 1000)}:F>`, inline: true },
            ],
            footer: { text: 'Los Angeles Exchange • Staff Recruitment' },
        }],
    });

    // Notify staff review channel
    if (client) {
        await notifyStaffReview(client, {
            applicationId,
            userId,
            username: session.username,
            answers: session.answers,
            submittedAt: now,
            guildId: session.guildId,
        });
    }

    return true;
}

/**
 * Notifies staff channel with the completed application and interactive review buttons.
 */
async function notifyStaffReview(client, appData) {
    const targetChannelId = process.env.APPLICATIONS_REVIEW_CHANNEL_ID ||
                            DEFAULT_APPLICATIONS_REVIEW_CHANNEL_ID ||
                            process.env.APPLICATIONS_CHANNEL_ID ||
                            process.env.MOD_LOG_CHANNEL_ID;

    if (!targetChannelId) {
        console.log(`[Applications] New application received for user ${appData.username} (${appData.userId}). No review channel configured.`);
        return;
    }

    try {
        const channel = await client.channels.fetch(targetChannelId).catch(() => null);
        if (!channel || typeof channel.send !== 'function') return;

        const fields = appData.answers.map((q, idx) => ({
            name: `${idx + 1}. ${q.title}`,
            value: `**Q:** ${q.question}\n**A:** ${q.answer.length > 900 ? q.answer.slice(0, 900) + '...' : q.answer}`,
            inline: false,
        }));

        const embed = {
            title: `📋 New LAX Representative Application (#${appData.applicationId || 'N/A'})`,
            description: `**Applicant:** <@${appData.userId}> (\`${appData.username}\`)\n**Status:** 🟡 **Pending Staff Approval**`,
            color: 0x5865F2,
            fields,
            footer: {
                text: `Submitted: ${new Date(appData.submittedAt).toUTCString()}`,
            },
        };

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`app:review:accept:${appData.applicationId}:${appData.userId}`)
                .setLabel('Accept Application')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId(`app:review:reject:${appData.applicationId}:${appData.userId}`)
                .setLabel('Reject Application')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        );

        await channel.send({
            content: `<@&${OWNER_ROLE_ID}> <@&${REPRESENTATIVE_ROLE_ID}> New application submitted for review:`,
            allowedMentions: { roles: [OWNER_ROLE_ID, REPRESENTATIVE_ROLE_ID] },
            embeds: [embed],
            components: [row],
        });
    } catch (err) {
        console.warn('[Applications] Failed to post application to staff review channel:', err.message);
    }
}

/**
 * Handles Staff Accept / Reject button clicks on application reviews.
 */
async function handleReviewButton(interaction, db, client) {
    if (!interaction.inGuild()) {
        return interaction.reply({ content: 'Review buttons can only be used in a server.', flags: MessageFlags.Ephemeral });
    }

    const hasPermission = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.member?.roles?.cache?.some(r => r.id === OWNER_ROLE_ID || r.id === REPRESENTATIVE_ROLE_ID);

    if (!hasPermission) {
        return interaction.reply({
            content: '❌ Only Administrators, Owners, or Representatives can review applications.',
            flags: MessageFlags.Ephemeral,
        });
    }

    const parts = interaction.customId.split(':');
    const action = parts[2]; // 'accept' or 'reject'
    const appId = parseInt(parts[3], 10);
    const applicantUserId = parts[4];

    await interaction.deferUpdate();

    const now = Date.now();
    const adminTag = interaction.user.tag || interaction.user.username;

    if (db && !isNaN(appId)) {
        try {
            await ensureTables(db);
            await db.prepare(`
                UPDATE applications
                SET status = ?, reviewed_by = ?, reviewed_at = ?
                WHERE id = ?
            `).run(action === 'accept' ? 'accepted' : 'rejected', interaction.user.id, now, appId);
        } catch (dbErr) {
            console.error('[Applications] Error updating application status in DB:', dbErr);
        }
    }

    // Assign Representative role upon approval
    if (action === 'accept' && interaction.guild && applicantUserId) {
        try {
            const role = interaction.guild.roles.cache.get(REPRESENTATIVE_ROLE_ID) ||
                         await interaction.guild.roles.fetch(REPRESENTATIVE_ROLE_ID).catch(() => null);
            if (role) {
                const member = await interaction.guild.members.fetch(applicantUserId).catch(() => null);
                if (member && !member.roles.cache.has(role.id)) {
                    await member.roles.add(role.id);
                    console.log(`[Applications] Assigned Representative role to user ${applicantUserId} upon application approval.`);
                }
            }
        } catch (roleErr) {
            console.warn('[Applications] Could not assign Representative role:', roleErr.message);
        }
    }

    // Notify applicant in DM
    if (client && applicantUserId) {
        try {
            const targetUser = await client.users.fetch(applicantUserId).catch(() => null);
            if (targetUser) {
                if (action === 'accept') {
                    await targetUser.send({
                        embeds: [{
                            title: '🎉 Application Accepted!',
                            description: `Congratulations! Your application for **LAX Representative** has been **ACCEPTED** by <@${interaction.user.id}>.\n\nYou have been granted the Representative role in the server. Welcome to the team!`,
                            color: 0x57F287,
                            footer: { text: 'Los Angeles Exchange • Staff Team' },
                        }],
                    }).catch(() => {});
                } else {
                    await targetUser.send({
                        embeds: [{
                            title: '📋 Application Status Update',
                            description: `Thank you for applying for the **LAX Representative** role.\n\nAfter review by our management team, we are unable to accept your application at this time. You are welcome to re-apply in the future.`,
                            color: 0xED4245,
                            footer: { text: 'Los Angeles Exchange • Staff Team' },
                        }],
                    }).catch(() => {});
                }
            }
        } catch (_) {}
    }

    // Update the review embed
    const originalEmbed = interaction.message.embeds[0] ? { ...interaction.message.embeds[0].data } : {};
    originalEmbed.color = action === 'accept' ? 0x57F287 : 0xED4245;
    originalEmbed.description = `**Applicant:** <@${applicantUserId}>\n**Status:** ${action === 'accept' ? '✅ **Accepted**' : '❌ **Rejected**'} by <@${interaction.user.id}> (\`${adminTag}\`)`;

    await interaction.message.edit({
        content: interaction.message.content,
        embeds: [originalEmbed],
        components: [], // Remove action buttons once decided
    }).catch(() => {});
}

module.exports = {
    DEFAULT_APPLICATION_CHANNEL_ID,
    DEFAULT_APPLICATIONS_REVIEW_CHANNEL_ID,
    REPRESENTATIVE_ROLE_ID,
    OWNER_ROLE_ID,
    COMPANY_OWNER_ROLE_ID,
    DEFAULT_APPLICATION_QUESTIONS,
    activeSessions,
    ensureTables,
    getApplicationStatus,
    setApplicationStatus,
    createApplicationPanelPayload,
    handleApplyButton,
    handleDirectMessage,
    notifyStaffReview,
    handleReviewButton,
};
