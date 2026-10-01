const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const {
    computePHash,
    computeDHash,
    computeAHash,
    generateFingerprintSuite,
    hammingDistance,
} = require('./perceptual-hash.js');

/**
 * Default perceptual hash fingerprints of known scam templates.
 */
const DEFAULT_SCAM_TEMPLATES = [
    {
        label: 'Template 1: Fake MrBeast Crypto Casino Giveaway',
        phash: 'bf30c81dd90f44ec',
        dhash: '80e080a0c08181c0',
    },
    {
        label: 'Template 2: Tolawin Bonus Code Activation (BET)',
        phash: 'be8513852d6347c7',
        dhash: '80c2c2c0c8c4c6ca',
    },
    {
        label: 'Template 3: Tolawin Withdrawal Success $5,600 Modal',
        phash: 'd07295979d97c1c1',
        dhash: '4b71716171714949',
    },
];

/**
 * Known scam text patterns and signatures extracted from the scam campaign.
 * Detected via local on-device OCR and content scanning without any external AI/cloud APIs.
 */
const SCAM_TEXT_SIGNATURES = [
    /tolawin/i,
    /tolawin\.com/i,
    /t0lawin/i,
    /to1awin/i,
    /promo\s*code\s*:?\s*BET/i,
    /code\s*:?\s*BET/i,
    /promo\s*code/i,
    /special\s*promo\s*code/i,
    /[$S]?5,?600\s*(bonus|reward|giveaway|USDT|dollar)/i,
    /5,?600\s*USDT/i,
    /cryptocurrency\s*casino/i,
    /crypto\s*casino/i,
    /launch\s*of\s*my\s*own\s*cryptocurrency\s*casino/i,
    /launch\s*of\s*the\s*Vyro\s*project/i,
    /Vyro/i,
    /Withdrawal\s*(of\s*)?[$S]?5,?600/i,
    /Your\s*Withdrawal\s*of\s*[$S]?5,?600(\.00)?\s*Was\s*Successfully/i,
    /Withdrawal\s*Success/i,
    /Receive\s*(your\s*)?[$S]?5,?600\s*bonus/i,
    /giving\s*away\s*[$S]?5,?600/i,
    /Rakeback/i,
];

// Maximum allowed image attachment size (8 MB)
const MAX_IMAGE_FILE_SIZE = 8 * 1024 * 1024;

// Default Hamming distance threshold for 64-bit perceptual hashes
const DEFAULT_DISTANCE_THRESHOLD = 14;

// User warning message sent in channel after scam deletion
const SCAM_WARNING_MESSAGE =
    '⚠️ This image was automatically removed because it matched a known scam/spam image.\n\n' +
    'If you believe this was a mistake, please contact server staff.';

// Track scanned message IDs to avoid redundant processing in periodic sweeps
const seenScannedMessageIds = new Set();
const MAX_SEEN_MESSAGES = 10000;

// Reusable local Tesseract worker
let tesseractWorker = null;
let tesseractInitPromise = null;

async function initLocalOcr() {
    if (tesseractWorker) return tesseractWorker;
    if (tesseractInitPromise) return tesseractInitPromise;

    tesseractInitPromise = (async () => {
        try {
            const worker = await Tesseract.createWorker('eng', 1, {
                logger: () => {},
                errorHandler: () => {},
            });
            tesseractWorker = worker;
            return worker;
        } catch (err) {
            console.warn('[ScamShield] Local OCR init note:', err.message);
            return null;
        } finally {
            tesseractInitPromise = null;
        }
    })();

    return tesseractInitPromise;
}

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
    return /\.(png|jpe?g|webp|bmp|tiff|avif|heic|heif)$/i.test(name.split('?')[0]);
}

/**
 * Extracts image URLs from message content, attachments, or embeds.
 */
function extractImageUrlsFromMessage(message) {
    const urls = [];

    if (message.attachments && message.attachments.size > 0) {
        for (const [, att] of message.attachments) {
            if (isImageAttachment(att)) {
                urls.push(att.url || att.proxyURL);
            }
        }
    }

    if (message.embeds && message.embeds.length > 0) {
        for (const embed of message.embeds) {
            if (embed.image?.url) urls.push(embed.image.url);
            if (embed.thumbnail?.url) urls.push(embed.thumbnail.url);
        }
    }

    if (message.content) {
        const urlMatches = message.content.match(/https?:\/\/[^\s<>"']+/gi) || [];
        for (const u of urlMatches) {
            if (/\.(png|jpe?g|webp|bmp|gif)(\?.*)?$/i.test(u) || u.includes('cdn.discordapp.com') || u.includes('media.discordapp.net')) {
                urls.push(u);
            }
        }
    }

    return Array.from(new Set(urls.filter(Boolean)));
}

/**
 * Downloads image safely with timeout and byte limit.
 */
async function downloadImageBuffer(url, { timeoutMs = 6000, maxBytes = MAX_IMAGE_FILE_SIZE } = {}) {
    if (!url || typeof url !== 'string') {
        throw new Error('Invalid download URL.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DiscordBot/1.0 (LAX ScamShield)',
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
 * Checks text content for scam signatures with fuzzy normalization.
 */
function matchScamText(text) {
    if (!text || typeof text !== 'string') return { isMatch: false, matchedKeyword: null };

    const rawNormalized = text.replace(/\s+/g, ' ').trim();
    const fuzzyNormalized = rawNormalized
        .replace(/0/g, 'o')
        .replace(/1/g, 'l')
        .replace(/5/g, 's')
        .replace(/[@]/g, 'a');

    for (const sig of SCAM_TEXT_SIGNATURES) {
        if (sig.test(rawNormalized) || sig.test(fuzzyNormalized)) {
            return { isMatch: true, matchedKeyword: String(sig) };
        }
    }

    return { isMatch: false, matchedKeyword: null };
}

/**
 * Runs local on-device OCR on the image buffer with strict timeout.
 */
async function runLocalOcr(imageBuffer, timeoutMs = 3500) {
    return new Promise(async (resolve) => {
        const timeout = setTimeout(() => resolve(''), timeoutMs);

        try {
            const ocrBuffer = await sharp(imageBuffer)
                .resize({ width: 900, withoutEnlargement: false, fit: 'inside' })
                .grayscale()
                .normalize()
                .toBuffer();

            const worker = await initLocalOcr();
            if (!worker) {
                clearTimeout(timeout);
                return resolve('');
            }

            const ret = await worker.recognize(ocrBuffer);
            clearTimeout(timeout);
            resolve(ret?.data?.text || '');
        } catch (_) {
            clearTimeout(timeout);
            resolve('');
        }
    });
}

/**
 * Inspects an image buffer using multi-region perceptual hashing AND local on-device OCR.
 */
async function inspectImageBuffer(imageBuffer, config = getConfig(), db = null) {
    try {
        // Fast Layer 1: Multi-Region Perceptual Hashes (under 5ms)
        const suite = await generateFingerprintSuite(imageBuffer);

        let centerSuite = null;
        let bottomSuite = null;
        try {
            const meta = await sharp(imageBuffer).metadata();
            if (meta.width && meta.height && meta.width > 30 && meta.height > 30) {
                // 75% center crop
                const cw = Math.round(meta.width * 0.75);
                const ch = Math.round(meta.height * 0.75);
                const left = Math.round((meta.width - cw) / 2);
                const top = Math.round((meta.height - ch) / 2);
                const centerBuf = await sharp(imageBuffer).extract({ left, top, width: cw, height: ch }).toBuffer();
                centerSuite = await generateFingerprintSuite(centerBuf);

                // Lower half crop (where the scam tweet / modal body is located)
                const botH = Math.round(meta.height * 0.6);
                const botTop = meta.height - botH;
                const botBuf = await sharp(imageBuffer).extract({ left: 0, top: botTop, width: meta.width, height: botH }).toBuffer();
                bottomSuite = await generateFingerprintSuite(botBuf);
            }
        } catch (_) {}

        let isMatch = false;
        let minDistance = Infinity;
        let matchedTemplate = null;

        for (const tmpl of DEFAULT_SCAM_TEMPLATES) {
            const pDist = hammingDistance(suite.phash, tmpl.phash);
            const dDist = tmpl.dhash ? hammingDistance(suite.dhash, tmpl.dhash) : Infinity;
            const centerPDist = centerSuite ? hammingDistance(centerSuite.phash, tmpl.phash) : Infinity;
            const botPDist = bottomSuite ? hammingDistance(bottomSuite.phash, tmpl.phash) : Infinity;

            const effectiveDist = Math.min(pDist, dDist, centerPDist, botPDist);
            if (effectiveDist < minDistance) {
                minDistance = effectiveDist;
                matchedTemplate = tmpl;
            }

            if (pDist <= config.threshold || dDist <= config.threshold || centerPDist <= config.threshold || botPDist <= config.threshold) {
                isMatch = true;
            }
        }

        // Fast Layer 2: Local On-Device Zero-Cloud OCR (catches screen photos, dark bezels, skewed angles)
        if (!isMatch) {
            const extractedText = await runLocalOcr(imageBuffer);
            const ocrMatch = matchScamText(extractedText);
            if (ocrMatch.isMatch) {
                isMatch = true;
                matchedTemplate = {
                    label: `Scam signature matched: ${ocrMatch.matchedKeyword}`,
                    phash: suite.phash,
                };
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
            matchedLabel: matchedTemplate?.label || 'Known scam image template',
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
                text: `ScamShield v1.0 • Distance: ${distance === Infinity ? 'OCR Keyword Match' : distance ?? 'N/A'} (threshold <= ${threshold ?? 'N/A'})`,
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

    // 1. Direct text link check in message content
    if (message.content) {
        const textMatch = matchScamText(message.content);
        if (textMatch.isMatch) {
            console.log(`[ScamShield] Detected scam link/text from user ${message.author?.id}: ${textMatch.matchedKeyword}`);
            let deleted = false;
            try {
                if (typeof message.delete === 'function') {
                    await message.delete();
                    deleted = true;
                }
            } catch (_) {}

            if (deleted && message.channel && typeof message.channel.send === 'function') {
                try {
                    const warningMsg = await message.channel.send({
                        content: SCAM_WARNING_MESSAGE,
                        allowedMentions: { parse: [] },
                    });
                    if (config.autoDeleteSeconds > 0 && warningMsg && typeof warningMsg.delete === 'function') {
                        setTimeout(() => warningMsg.delete().catch(() => {}), config.autoDeleteSeconds * 1000);
                    }
                } catch (_) {}
            }

            if (config.logChannelId && client) {
                await sendModLog(client, config.logChannelId, {
                    user: message.author,
                    channel: message.channel,
                    messageId: message.id,
                    timestamp: message.createdTimestamp || Date.now(),
                    distance: 'Text Scam Match',
                    threshold: config.threshold,
                    matchedLabel: `Scam link in message: ${textMatch.matchedKeyword}`,
                });
            }

            return { scanned: true, detected: true, deleted, matchedKeyword: textMatch.matchedKeyword };
        }
    }

    // 2. Extract image URLs from attachments, embeds, content
    const imageUrls = extractImageUrlsFromMessage(message);
    if (imageUrls.length === 0) {
        return { scanned: false, reason: 'no_image_attachments' };
    }

    let scamDetected = false;
    let detectionResult = null;

    for (const url of imageUrls) {
        try {
            const buffer = await downloadImageBuffer(url, {
                maxBytes: config.maxFileSizeBytes,
                timeoutMs: options.timeoutMs || 6000,
            });

            const result = await inspectImageBuffer(buffer, config, db);
            if (result.success && result.isMatch) {
                scamDetected = true;
                detectionResult = result;
                console.log(`[ScamShield] SCAM IMAGE DETECTED in message ${message.id} by ${message.author?.username}: ${result.matchedLabel}`);
                break;
            }
        } catch (downloadOrScanError) {
            console.warn(`[ScamShield] Error inspecting image ${url}:`, downloadOrScanError.message);
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
            if (!channel.isTextBased || !channel.isTextBased() || typeof channel.messages?.fetch !== 'function') {
                continue;
            }

            try {
                channelsScanned++;
                const messages = await channel.messages.fetch({ limit: options.messageLimit || 15 }).catch(() => null);
                if (!messages || messages.size === 0) continue;

                for (const [, message] of messages) {
                    if (message.author?.bot) continue;
                    if (seenScannedMessageIds.has(message.id)) continue;

                    const hasImages = (message.attachments && message.attachments.size > 0) ||
                                      (message.embeds && message.embeds.length > 0) ||
                                      (message.content && /https?:\/\//i.test(message.content));
                    if (!hasImages) continue;

                    messagesScanned++;
                    const scanRes = await handleMessage(message, client, config, db);
                    if (scanRes?.detected) {
                        scamDetectedCount++;
                    }
                }
            } catch (_) {}
        }
    }

    return { channelsScanned, messagesScanned, scamDetectedCount };
}

/**
 * Starts the 10-second automatic message scanner timer.
 */
function startPeriodicScanner(client, db = null, intervalMs = 10000) {
    initLocalOcr().catch(() => {});

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

async function terminateLocalOcr() {
    if (tesseractWorker) {
        try {
            await tesseractWorker.terminate();
        } catch (_) {}
        tesseractWorker = null;
    }
}

module.exports = {
    DEFAULT_SCAM_TEMPLATES,
    SCAM_TEXT_SIGNATURES,
    DEFAULT_DISTANCE_THRESHOLD,
    SCAM_WARNING_MESSAGE,
    getConfig,
    isImageAttachment,
    extractImageUrlsFromMessage,
    downloadImageBuffer,
    inspectImageBuffer,
    matchScamText,
    runLocalOcr,
    terminateLocalOcr,
    handleMessage,
    sendModLog,
    scanRecentGuildChannels,
    startPeriodicScanner,
};
