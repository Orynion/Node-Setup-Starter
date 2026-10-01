const { computePHash, computeDHash, hammingDistance, binaryToHex } = require('./perceptual-hash.js');

/**
 * Default perceptual hash fingerprints of known scam templates.
 * Stored as 16-character hexadecimal strings (64-bit DCT pHash).
 * These fingerprints are generated from the known reference scam images.
 */
const DEFAULT_SCAM_FINGERPRINTS = [
    'bf30c81dd90f44ec', // Template 1: Fake crypto casino announcement
    'be8513852d6347c7', // Template 2: Fake bonus promo code / rakeback claim
    'd07295979d97c1c1', // Template 3: Fake withdrawal success screen
];

// Maximum allowed image attachment size (8 MB)
const MAX_IMAGE_FILE_SIZE = 8 * 1024 * 1024;

// Default Hamming distance threshold for 64-bit DCT pHash
// 0-4: identical/near-identical with heavy compression
// 5-10: resized/re-encoded scam copies
// >20: distinct/unrelated images (random image average distance is ~32)
const DEFAULT_DISTANCE_THRESHOLD = 10;

// User warning message sent in channel after scam deletion
const SCAM_WARNING_MESSAGE =
    '⚠️ This image was automatically removed because it matched a known scam/spam image.\n\n' +
    'If you believe this was a mistake, please contact server staff.';

/**
 * Retrieves the active configuration for ScamShield.
 * Allows override via environment variables.
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

    let referenceHashes = [...DEFAULT_SCAM_FINGERPRINTS];
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
 * Checks if a Discord attachment is an eligible image.
 */
function isImageAttachment(attachment, maxBytes = MAX_IMAGE_FILE_SIZE) {
    if (!attachment || typeof attachment !== 'object') return false;

    // Check size limit
    if (typeof attachment.size === 'number' && (attachment.size <= 0 || attachment.size > maxBytes)) {
        return false;
    }

    // Check content type
    if (attachment.contentType && typeof attachment.contentType === 'string') {
        const ct = attachment.contentType.toLowerCase();
        if (ct.startsWith('image/')) {
            // Exclude svgs if any
            if (ct === 'image/svg+xml') return false;
            return true;
        }
    }

    // Fallback to filename extension
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
 * Compares an image buffer against reference scam fingerprints.
 */
async function inspectImageBuffer(imageBuffer, config = getConfig()) {
    try {
        const { hex, binary } = await computePHash(imageBuffer);

        let isMatch = false;
        let minDistance = Infinity;
        let matchedReferenceHash = null;

        for (const refHash of config.referenceHashes) {
            const dist = hammingDistance(hex, refHash);
            if (dist < minDistance) {
                minDistance = dist;
                matchedReferenceHash = refHash;
            }
            if (dist <= config.threshold) {
                isMatch = true;
            }
        }

        return {
            success: true,
            isMatch,
            hash: hex,
            binary,
            minDistance,
            matchedReferenceHash,
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

        const { user, channel: msgChannel, messageId, timestamp, distance, threshold } = logData;

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
                    value: 'Known scam image template',
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
 * Main message handler for Discord messageCreate event.
 * Scans image attachments and acts if a known scam template is detected.
 */
async function handleMessage(message, client, options = {}) {
    // 1. Ignore bot messages to prevent feedback loops
    if (!message || message.author?.bot) {
        return { scanned: false, reason: 'bot_message' };
    }

    const config = getConfig(options);

    // 2. Check if feature is enabled
    if (!config.enabled) {
        return { scanned: false, reason: 'disabled' };
    }

    // 3. Inspect attachments
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

            const result = await inspectImageBuffer(buffer, config);
            if (result.success && result.isMatch) {
                scamDetected = true;
                detectionResult = result;
                break;
            }
        } catch (downloadOrScanError) {
            // Gracefully handle download/scanning errors without deleting user message or crashing
            console.warn(`[ScamShield] Error inspecting attachment ${attachment.id || 'unknown'}:`, downloadOrScanError.message);
        }
    }

    if (!scamDetected) {
        return { scanned: true, detected: false };
    }

    // Scam image detected -> Proceed with deletion and notifications
    let deleted = false;
    try {
        if (typeof message.delete === 'function') {
            await message.delete();
            deleted = true;
        }
    } catch (deleteError) {
        console.error('[ScamShield] Failed to delete scam message (check bot permissions):', deleteError.message);
    }

    // Send brief warning message to channel
    if (deleted && message.channel && typeof message.channel.send === 'function') {
        try {
            const warningMsg = await message.channel.send({
                content: SCAM_WARNING_MESSAGE,
                allowedMentions: { parse: [] },
            });

            // Auto-delete warning message after configured time to keep channel clean
            if (config.autoDeleteSeconds > 0 && warningMsg && typeof warningMsg.delete === 'function') {
                setTimeout(() => {
                    warningMsg.delete().catch(() => {});
                }, config.autoDeleteSeconds * 1000);
            }
        } catch (warningError) {
            console.warn('[ScamShield] Failed to send warning in channel:', warningError.message);
        }
    }

    // Send private moderation log
    if (config.logChannelId && client) {
        await sendModLog(client, config.logChannelId, {
            user: message.author,
            channel: message.channel,
            messageId: message.id,
            timestamp: message.createdTimestamp || Date.now(),
            distance: detectionResult?.minDistance,
            threshold: config.threshold,
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

module.exports = {
    DEFAULT_SCAM_FINGERPRINTS,
    DEFAULT_DISTANCE_THRESHOLD,
    SCAM_WARNING_MESSAGE,
    getConfig,
    isImageAttachment,
    downloadImageBuffer,
    inspectImageBuffer,
    handleMessage,
    sendModLog,
};
