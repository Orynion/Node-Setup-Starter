const {
    computePHash,
    computeDHash,
    computeAHash,
    generateFingerprintSuite,
    hammingDistance,
} = require('./perceptual-hash.js');

/**
 * Default perceptual hash fingerprints of known scam templates.
 * Stored with descriptive labels and both pHash and dHash fingerprints.
 */
const DEFAULT_SCAM_TEMPLATES = [
    {
        label: 'Template 1: Fake MrBeast Crypto Casino Giveaway',
        phash: 'bf30c81dd90f44ec',
        dhash: '80e080a0c08181c0',
        ahash: '0000000000000000',
    },
    {
        label: 'Template 2: Tolawin Bonus Code Activation (BET)',
        phash: 'be8513852d6347c7',
        dhash: '80c2c2c0c8c4c6ca',
        ahash: '0000000000000000',
    },
    {
        label: 'Template 3: Tolawin Withdrawal Success $5,600 Modal',
        phash: 'd07295979d97c1c1',
        dhash: '4b71716171714949',
        ahash: '0000000000000000',
    },
];

// Maximum allowed image attachment size (8 MB)
const MAX_IMAGE_FILE_SIZE = 8 * 1024 * 1024;

// Default Hamming distance threshold for 64-bit DCT pHash
const DEFAULT_DISTANCE_THRESHOLD = 10;

// User warning message sent in channel after scam deletion
const SCAM_WARNING_MESSAGE =
    '⚠️ This image was automatically removed because it matched a known scam/spam image.\n\n' +
    'If you believe this was a mistake, please contact server staff.';

// In-memory cache for dynamic DB-backed fingerprints
let cachedDbFingerprints = null;
let lastCacheSync = 0;
const CACHE_TTL_MS = 60000;

// Track scanned message IDs to avoid redundant processing in periodic sweeps
const seenScannedMessageIds = new Set();
const MAX_SEEN_MESSAGES = 10000;

/**
 * Retrieves the active configuration for ScamShield.
 */
function getConfig(overrides = {}) {
    const envEnabled = process.env.SCAM_IMAGE_DETECTION_ENABLED;
    const enabled = overrides.enabled !== undefined
        ? overrides.enabled
        : (envEnabled === undefined || envEnabled === 'true' || envEnabled === '1');

    const envThreshold = parseInt(process.env.SCAM_IMAGE_HASH_DISTANCE_THRESHOLD, 10);
    const threshold = overrides.threshold !== undefined
        ? overrides.threshold
        : (!isNaN(envThreshold) && envThreshold >= 0 ? envThreshold : DEFAULT_DISTANCE_THRESHOLD);

    const logChannelId = (overrides.logChannelId !== undefined
        ? overrides.logChannelId
        : (process.env.SCAM_IMAGE_LOG_CHANNEL_ID || process.env.MOD_LOG_CHANNEL_ID || '')
    ).trim();

    const autoDeleteSeconds = overrides.autoDeleteSeconds !== undefined
        ? overrides.autoDeleteSeconds
        : (parseInt(process.env.SCAM_IMAGE_WARNING_AUTO_DELETE_SECONDS, 10) || 10);

    let referenceHashes = DEFAULT_SCAM_TEMPLATES.map(t => t.phash);
    const customHashesEnv = process.env.SCAM_IMAGE_REFERENCE_HASHES || process.env.SCAM_IMAGE_REFERENCE_HASH;
    if (customHashesEnv && customHashesEnv.trim()) {
        const parsedCustom = customHashesEnv
            .split(',')
            .map(h => h.trim().toLowerCase())
            .filter(h => /^[0-9a-f]{16}$/i.test(h));
        if (parsedCustom.length > 0) {
            referenceHashes = parsedCustom;
        }
    }
    if (overrides.referenceHashes && Array.isArray(overrides.referenceHashes) && overrides.referenceHashes.length > 0) {
        referenceHashes = overrides.referenceHashes.map(h => h.trim().toLowerCase());
    }

    return {
        enabled,
        threshold,
        logChannelId,
        autoDeleteSeconds,
        referenceHashes,
        maxFileSizeBytes: overrides.maxFileSizeBytes || MAX_IMAGE_FILE_SIZE,
    };
}

/**
 * Loads all active fingerprints combining defaults, environment, and database records.
 */
async function loadAllActiveFingerprints(db = null, config = getConfig()) {
    const list = [...DEFAULT_SCAM_TEMPLATES];

    // Merge any environment-configured custom hashes
    for (const h of config.referenceHashes) {
        if (!list.some(item => item.phash.toLowerCase() === h.toLowerCase())) {
            list.push({
                label: 'Configured Reference Template',
                phash: h.toLowerCase(),
                dhash: null,
                ahash: null,
            });
        }
    }

    // Merge database stored fingerprints if db is available
    if (db) {
        const now = Date.now();
        if (cachedDbFingerprints && now - lastCacheSync < CACHE_TTL_MS) {
            for (const item of cachedDbFingerprints) {
                if (!list.some(existing => existing.phash.toLowerCase() === item.phash.toLowerCase())) {
                    list.push(item);
                }
            }
        } else {
            try {
                const rows = await db.prepare('SELECT * FROM scam_fingerprints').all();
                cachedDbFingerprints = rows || [];
                lastCacheSync = now;
                for (const item of cachedDbFingerprints) {
                    if (!list.some(existing => existing.phash.toLowerCase() === item.phash.toLowerCase())) {
                        list.push(item);
                    }
                }
            } catch (err) {
                // Ignore DB error if table is not yet initialized in isolated unit tests
            }
        }
    }

    return list;
}

/**
 * Checks if a Discord attachment is an eligible image.
 */
function isImageAttachment(attachment, maxBytes = MAX_IMAGE_FILE_SIZE) {
    if (!attachment || typeof attachment !== 'object') return false;

    if (typeof attachment.size === 'number' && (attachment.size <= 0 || attachment.size > maxBytes)) {
        return false;
    }

    if (attachment.contentType && typeof attachment.contentType === 'string') {
        const ct = attachment.contentType.toLowerCase();
        if (ct.startsWith('image/')) {
            if (ct === 'image/svg+xml') return false;
            return true;
        }
    }

    const name = (attachment.name || attachment.url || '').toLowerCase();
    return /\.(png|jpe?g|webp|bmp|tiff|avif)$/i.test(name.split('?')[0]);
}

/**
 * Downloads image safely with timeout and byte limit.
 */
async function downloadImageBuffer(url, { timeoutMs = 5000, maxBytes = MAX_IMAGE_FILE_SIZE } = {}) {
    if (!url || typeof url !== 'string') {
        throw new Error('Invalid download URL.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'LAX-ScamShield/1.0',
            },
        });

        if (!response.ok) {
            throw new Error(`Download failed with status ${response.status} ${response.statusText}`);
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxBytes) {
            throw new Error(`Attachment exceeds maximum size of ${maxBytes} bytes`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (buffer.length > maxBytes) {
            throw new Error(`Downloaded image exceeds maximum size of ${maxBytes} bytes`);
        }

        return buffer;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Inspects an image buffer and performs multi-fingerprint matching.
 */
async function inspectImageBuffer(imageBuffer, config = getConfig(), db = null) {
    try {
        const suite = await generateFingerprintSuite(imageBuffer);
        const allTemplates = await loadAllActiveFingerprints(db, config);

        let isMatch = false;
        let minDistance = Infinity;
        let matchedTemplate = null;

        for (const tmpl of allTemplates) {
            const pDist = hammingDistance(suite.phash, tmpl.phash);
            const dDist = tmpl.dhash ? hammingDistance(suite.dhash, tmpl.dhash) : Infinity;

            const effectiveDist = Math.min(pDist, dDist);
            if (effectiveDist < minDistance) {
                minDistance = effectiveDist;
                matchedTemplate = tmpl;
            }

            if (pDist <= config.threshold || (tmpl.dhash && dDist <= config.threshold)) {
                isMatch = true;
            }
        }

        return {
            success: true,
            isMatch,
            hash: suite.phash,
            dhash: suite.dhash,
            ahash: suite.ahash,
            minDistance,
            matchedReferenceHash: matchedTemplate?.phash || null,
            matchedLabel: matchedTemplate?.label || 'Known scam image',
            threshold: config.threshold,
        };
    } catch (err) {
        return {
            success: false,
            isMatch: false,
            error: err.message,
        };
    }
}

/**
 * Sends a structured private moderation log embed.
 */
async function sendModLog(client, logChannelId, logData) {
    if (!client || !logChannelId) return;

    try {
        const channel = await client.channels.fetch(logChannelId).catch(() => null);
        if (!channel || typeof channel.send !== 'function') return;

        const { user, channel: msgChannel, messageId, timestamp, distance, threshold, matchedLabel } = logData;

        const embed = {
            title: '🛡️ ScamShield: Known Scam Image Detected',
            color: 0xED4245,
            fields: [
                {
                    name: 'User',
                    value: user ? `<@${user.id}> (${user.tag || user.username || user.id})` : 'Unknown User',
                    inline: true,
                },
                {
                    name: 'Channel',
                    value: msgChannel ? `<#${msgChannel.id}> (\`${msgChannel.name || msgChannel.id}\`)` : 'Unknown Channel',
                    inline: true,
                },
                {
                    name: 'Message ID',
                    value: `\`${messageId || 'N/A'}\``,
                    inline: true,
                },
                {
                    name: 'Detection Type',
                    value: matchedLabel || 'Known scam image template',
                    inline: true,
                },
                {
                    name: 'Action Taken',
                    value: '🗑️ **Message Deleted**',
                    inline: true,
                },
                {
                    name: 'Timestamp',
                    value: `<t:${Math.floor((timestamp || Date.now()) / 1000)}:F>`,
                    inline: true,
                },
            ],
            footer: {
                text: `ScamShield v1.0 • Match distance: ${distance ?? 'N/A'} (threshold <= ${threshold ?? 'N/A'})`,
            },
        };

        await channel.send({ embeds: [embed] }).catch(err => {
            console.warn('[ScamShield] Failed to post to mod log channel:', err.message);
        });
    } catch (err) {
        console.warn('[ScamShield] Mod log error:', err.message);
    }
}

/**
 * Main message handler for Discord message scanning.
 */
async function handleMessage(message, client, options = {}, db = null) {
    if (!message || message.author?.bot) {
        return { scanned: false, reason: 'bot_message' };
    }

    const config = getConfig(options);

    if (!config.enabled) {
        return { scanned: false, reason: 'disabled' };
    }

    if (message.id) {
        if (seenScannedMessageIds.has(message.id)) {
            return { scanned: false, reason: 'already_scanned' };
        }
        seenScannedMessageIds.add(message.id);
        if (seenScannedMessageIds.size > MAX_SEEN_MESSAGES) {
            const firstEntry = seenScannedMessageIds.values().next().value;
            seenScannedMessageIds.delete(firstEntry);
        }
    }

    const attachments = message.attachments;
    if (!attachments || attachments.size === 0) {
        return { scanned: false, reason: 'no_attachments' };
    }

    const imageAttachments = [];
    for (const [, attachment] of attachments) {
        if (isImageAttachment(attachment, config.maxFileSizeBytes)) {
            imageAttachments.push(attachment);
        }
    }

    if (imageAttachments.length === 0) {
        return { scanned: false, reason: 'no_image_attachments' };
    }

    let scamDetected = false;
    let detectionResult = null;

    for (const attachment of imageAttachments) {
        try {
            const buffer = await downloadImageBuffer(attachment.url, {
                maxBytes: config.maxFileSizeBytes,
                timeoutMs: options.timeoutMs || 5000,
            });

            const result = await inspectImageBuffer(buffer, config, db);
            if (result.success && result.isMatch) {
                scamDetected = true;
                detectionResult = result;
                break;
            }
        } catch (downloadOrScanError) {
            console.warn(`[ScamShield] Error inspecting attachment ${attachment.id || 'unknown'}:`, downloadOrScanError.message);
        }
    }

    if (!scamDetected) {
        return { scanned: true, detected: false };
    }

    let deleted = false;
    try {
        if (typeof message.delete === 'function') {
            await message.delete();
            deleted = true;
        }
    } catch (deleteError) {
        console.error('[ScamShield] Failed to delete scam message (check bot permissions):', deleteError.message);
    }

    if (deleted && message.channel && typeof message.channel.send === 'function') {
        try {
            const warningMsg = await message.channel.send({
                content: SCAM_WARNING_MESSAGE,
                allowedMentions: { parse: [] },
            });

            if (config.autoDeleteSeconds > 0 && warningMsg && typeof warningMsg.delete === 'function') {
                setTimeout(() => {
                    warningMsg.delete().catch(() => {});
                }, config.autoDeleteSeconds * 1000);
            }
        } catch (warningError) {
            console.warn('[ScamShield] Failed to send warning in channel:', warningError.message);
        }
    }

    if (config.logChannelId && client) {
        await sendModLog(client, config.logChannelId, {
            user: message.author,
            channel: message.channel,
            messageId: message.id,
            timestamp: message.createdTimestamp || Date.now(),
            distance: detectionResult?.minDistance,
            threshold: config.threshold,
            matchedLabel: detectionResult?.matchedLabel,
        });
    }

    return {
        scanned: true,
        detected: true,
        deleted,
        minDistance: detectionResult?.minDistance,
        matchedReferenceHash: detectionResult?.matchedReferenceHash,
        hash: detectionResult?.hash,
    };
}

/**
 * Scans recent messages across all accessible text channels in guilds.
 * Runs periodically (every 10 seconds) to catch any scam images.
 */
async function scanRecentGuildChannels(client, db = null, options = {}) {
    if (!client?.guilds?.cache) return { channelsScanned: 0, messagesScanned: 0, scamDetectedCount: 0 };

    const config = getConfig(options);
    if (!config.enabled) return { channelsScanned: 0, messagesScanned: 0, scamDetectedCount: 0 };

    let channelsScanned = 0;
    let messagesScanned = 0;
    let scamDetectedCount = 0;

    for (const [, guild] of client.guilds.cache) {
        if (!guild.channels?.cache) continue;

        for (const [, channel] of guild.channels.cache) {
            // Only scan text channels or announcement channels
            if (!channel.isTextBased || !channel.isTextBased() || typeof channel.messages?.fetch !== 'function') {
                continue;
            }

            try {
                channelsScanned++;
                const messages = await channel.messages.fetch({ limit: options.messageLimit || 10 }).catch(() => null);
                if (!messages || messages.size === 0) continue;

                for (const [, message] of messages) {
                    if (message.author?.bot) continue;
                    if (!message.attachments || message.attachments.size === 0) continue;
                    if (seenScannedMessageIds.has(message.id)) continue;

                    messagesScanned++;
                    const scanRes = await handleMessage(message, client, config, db);
                    if (scanRes?.detected) {
                        scamDetectedCount++;
                    }
                }
            } catch (chanErr) {
                // Ignore channels without permission
            }
        }
    }

    return { channelsScanned, messagesScanned, scamDetectedCount };
}

/**
 * Starts the 10-second automatic message scanner timer.
 */
function startPeriodicScanner(client, db = null, intervalMs = 10000) {
    let isRunning = false;

    const timer = setInterval(async () => {
        if (isRunning) return;
        isRunning = true;
        try {
            await scanRecentGuildChannels(client, db);
        } catch (err) {
            console.error('[ScamShield] Periodic 10-second scan error:', err.message);
        } finally {
            isRunning = false;
        }
    }, intervalMs);

    if (timer.unref) timer.unref();
    return timer;
}

module.exports = {
    DEFAULT_SCAM_TEMPLATES,
    DEFAULT_DISTANCE_THRESHOLD,
    SCAM_WARNING_MESSAGE,
    getConfig,
    loadAllActiveFingerprints,
    isImageAttachment,
    downloadImageBuffer,
    inspectImageBuffer,
    handleMessage,
    sendModLog,
    scanRecentGuildChannels,
    startPeriodicScanner,
};
