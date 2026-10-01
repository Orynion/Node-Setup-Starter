const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const {
    computePHash,
    computeDHash,
    computeAHash,
    generateFingerprintSuite,
    hammingDistance,
} = require('../src/perceptual-hash.js');
const scamShield = require('../src/scam-shield.js');
const { commands } = require('../src/deploy-commands.js');

// Path to test images
const ATTACHED_DIR = path.join(__dirname, '..', 'attached_assets');
const testImages = fs.readdirSync(ATTACHED_DIR).filter(f => f.endsWith('.png'));

test('Deploy Commands: Clean slash commands list (no redundant scamshield commands)', () => {
    const cmd = commands.find(c => c.name === 'admin-scamshield');
    assert.strictEqual(cmd, undefined, 'admin-scamshield command should not be in slash commands');
});

test('Perceptual Hash: Correctly generates consistent 64-bit DCT pHash and dHash', async () => {
    assert.ok(testImages.length > 0, 'Should have attached test images');
    const imagePath = path.join(ATTACHED_DIR, testImages[0]);
    const buffer = fs.readFileSync(imagePath);

    const suite = await generateFingerprintSuite(buffer);
    assert.strictEqual(suite.phash.length, 16, 'Hex pHash must be 16 characters (64-bit)');
    assert.strictEqual(suite.phashBin.length, 64, 'Binary pHash must be 64 characters');
    assert.strictEqual(suite.dhash.length, 16, 'Hex dHash must be 16 characters (64-bit)');
    assert.strictEqual(suite.dhashBin.length, 64, 'Binary dHash must be 64 characters');
    assert.strictEqual(hammingDistance(suite.phash, suite.phash), 0, 'Self distance must be 0');
});

test('ScamShield: Detects all known scam reference images', async () => {
    for (const imgName of testImages) {
        const buffer = fs.readFileSync(path.join(ATTACHED_DIR, imgName));
        const result = await scamShield.inspectImageBuffer(buffer);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.isMatch, true, `Image ${imgName} should be detected as scam`);
        assert.strictEqual(result.minDistance, 0, `Exact reference image ${imgName} must have distance 0`);
    }
});

test('ScamShield: Detects resized versions of the scam images', async () => {
    const buffer = fs.readFileSync(path.join(ATTACHED_DIR, testImages[0]));
    const meta = await sharp(buffer).metadata();

    // 50% scale
    const halfScale = await sharp(buffer)
        .resize(Math.round(meta.width * 0.5), Math.round(meta.height * 0.5))
        .toBuffer();
    const halfResult = await scamShield.inspectImageBuffer(halfScale);
    assert.strictEqual(halfResult.isMatch, true);
    assert.ok(halfResult.minDistance <= 4, `50% resized distance was ${halfResult.minDistance}`);

    // 25% scale
    const quarterScale = await sharp(buffer)
        .resize(Math.round(meta.width * 0.25), Math.round(meta.height * 0.25))
        .toBuffer();
    const quarterResult = await scamShield.inspectImageBuffer(quarterScale);
    assert.strictEqual(quarterResult.isMatch, true);
    assert.ok(quarterResult.minDistance <= 4, `25% resized distance was ${quarterResult.minDistance}`);
});

test('ScamShield: Detects heavily compressed and format-converted scam images', async () => {
    const buffer = fs.readFileSync(path.join(ATTACHED_DIR, testImages[0]));

    // Low quality JPEG (q=25)
    const jpegBuf = await sharp(buffer).jpeg({ quality: 25 }).toBuffer();
    const jpegResult = await scamShield.inspectImageBuffer(jpegBuf);
    assert.strictEqual(jpegResult.isMatch, true);
    assert.ok(jpegResult.minDistance <= 6, `JPEG q=25 distance was ${jpegResult.minDistance}`);

    // WebP converted
    const webpBuf = await sharp(buffer).webp({ quality: 40 }).toBuffer();
    const webpResult = await scamShield.inspectImageBuffer(webpBuf);
    assert.strictEqual(webpResult.isMatch, true);
    assert.ok(webpResult.minDistance <= 6, `WebP distance was ${webpResult.minDistance}`);
});

test('ScamShield: Detects slightly modified version (brightness / slight contrast adjustment)', async () => {
    const buffer = fs.readFileSync(path.join(ATTACHED_DIR, testImages[0]));
    const modifiedBuf = await sharp(buffer).modulate({ brightness: 1.08, saturation: 1.05 }).toBuffer();

    const result = await scamShield.inspectImageBuffer(modifiedBuf);
    assert.strictEqual(result.isMatch, true);
    assert.ok(result.minDistance <= 6, `Slightly modified distance was ${result.minDistance}`);
});

test('ScamShield: Unrelated image is NOT detected (False positive protection)', async () => {
    // Generate a solid blue image
    const blueBuf = await sharp({
        create: {
            width: 500,
            height: 500,
            channels: 3,
            background: { r: 10, g: 80, b: 220 },
        },
    }).png().toBuffer();

    const blueResult = await scamShield.inspectImageBuffer(blueBuf);
    assert.strictEqual(blueResult.isMatch, false);
    assert.ok(blueResult.minDistance >= 15, `Unrelated solid image distance should be high, was ${blueResult.minDistance}`);

    // Generate a graphic with shapes
    const patternBuf = await sharp({
        create: {
            width: 400,
            height: 300,
            channels: 3,
            background: { r: 240, g: 240, b: 240 },
        },
    })
    .composite([
        {
            input: Buffer.from(
                `<svg width="400" height="300">
                    <rect x="20" y="20" width="100" height="260" fill="green"/>
                    <circle cx="250" cy="150" r="80" fill="orange"/>
                </svg>`
            ),
            top: 0,
            left: 0,
        }
    ])
    .png()
    .toBuffer();

    const patternResult = await scamShield.inspectImageBuffer(patternBuf);
    assert.strictEqual(patternResult.isMatch, false);
    assert.ok(patternResult.minDistance >= 15, `Unrelated graphic distance should be high, was ${patternResult.minDistance}`);
});

test('ScamShield: Attachment filter ignores non-images and oversized files', () => {
    assert.strictEqual(scamShield.isImageAttachment({ name: 'document.pdf', contentType: 'application/pdf', size: 1024 }), false);
    assert.strictEqual(scamShield.isImageAttachment({ name: 'script.js', contentType: 'text/javascript', size: 500 }), false);
    assert.strictEqual(scamShield.isImageAttachment({ name: 'archive.zip', contentType: 'application/zip', size: 2048 }), false);
    assert.strictEqual(scamShield.isImageAttachment({ name: 'photo.png', contentType: 'image/png', size: 20 * 1024 * 1024 }), false, 'Oversized (>8MB) should be ignored');
    assert.strictEqual(scamShield.isImageAttachment({ name: 'photo.png', contentType: 'image/png', size: 50000 }), true);
    assert.strictEqual(scamShield.isImageAttachment({ name: 'banner.jpg', size: 80000 }), true);
    assert.strictEqual(scamShield.isImageAttachment(null), false);
    assert.strictEqual(scamShield.isImageAttachment({}), false);
});

test('ScamShield: Bot messages are ignored to prevent loops', async () => {
    const mockMessage = {
        author: { bot: true, id: '123456789' },
        attachments: new Map([
            ['1', { url: 'https://example.com/scam.png', contentType: 'image/png', size: 1000 }]
        ]),
    };

    const result = await scamShield.handleMessage(mockMessage, null);
    assert.strictEqual(result.scanned, false);
    assert.strictEqual(result.reason, 'bot_message');
});

test('ScamShield: Disabled feature does nothing', async () => {
    const mockMessage = {
        author: { bot: false, id: '123456789' },
        attachments: new Map([
            ['1', { url: 'https://example.com/scam.png', contentType: 'image/png', size: 1000 }]
        ]),
    };

    const result = await scamShield.handleMessage(mockMessage, null, { enabled: false });
    assert.strictEqual(result.scanned, false);
    assert.strictEqual(result.reason, 'disabled');
});

test('ScamShield: Messages with no attachments are skipped cleanly', async () => {
    const mockMessage = {
        author: { bot: false, id: '123456789' },
        attachments: new Map(),
    };

    const result = await scamShield.handleMessage(mockMessage, null);
    assert.strictEqual(result.scanned, false);
    assert.strictEqual(result.reason, 'no_image_attachments');
});

test('ScamShield: Detection failure (corrupted image / download failure) does NOT delete message', async () => {
    let messageDeleted = false;
    const mockMessage = {
        id: 'msg_999',
        author: { bot: false, id: 'user_123', username: 'NormalUser' },
        attachments: new Map([
            ['1', { url: 'https://invalid-non-existent-domain-12345.com/broken.png', contentType: 'image/png', size: 1000 }]
        ]),
        delete: async () => { messageDeleted = true; },
        channel: {
            id: 'chan_123',
            send: async () => ({ delete: async () => {} }),
        },
    };

    const result = await scamShield.handleMessage(mockMessage, null, { timeoutMs: 200 });
    assert.strictEqual(result.scanned, true);
    assert.strictEqual(result.detected, false);
    assert.strictEqual(messageDeleted, false, 'Message must NOT be deleted when attachment download fails');
});

test('ScamShield: Discord deletion failure is handled gracefully without crashing', async () => {
    const scamBuffer = fs.readFileSync(path.join(ATTACHED_DIR, testImages[0]));
    const originalFetch = global.fetch;

    global.fetch = async () => ({
        ok: true,
        headers: new Headers({ 'content-length': String(scamBuffer.length) }),
        arrayBuffer: async () => scamBuffer.buffer.slice(scamBuffer.byteOffset, scamBuffer.byteOffset + scamBuffer.byteLength),
    });

    try {
        const mockMessage = {
            id: 'msg_scam_001',
            author: { bot: false, id: 'user_scammer', username: 'Scammer123' },
            attachments: new Map([
                ['1', { url: 'https://cdn.discordapp.com/attachments/scam.png', contentType: 'image/png', size: scamBuffer.length }]
            ]),
            delete: async () => {
                throw new Error('DiscordAPIError[50013]: Missing Permissions');
            },
            channel: {
                id: 'chan_main',
                send: async () => ({ delete: async () => {} }),
            },
        };

        const result = await scamShield.handleMessage(mockMessage, null);
        assert.strictEqual(result.scanned, true);
        assert.strictEqual(result.detected, true);
        assert.strictEqual(result.deleted, false, 'Deletion failed due to permission error');
    } finally {
        global.fetch = originalFetch;
    }
});

test('ScamShield: Full detection, deletion, user warning, and mod logging flow', async () => {
    const scamBuffer = fs.readFileSync(path.join(ATTACHED_DIR, testImages[0]));
    const originalFetch = global.fetch;

    let messageDeleted = false;
    let channelWarningSent = null;
    let modLogEmbedSent = null;

    global.fetch = async () => ({
        ok: true,
        headers: new Headers({ 'content-length': String(scamBuffer.length) }),
        arrayBuffer: async () => scamBuffer.buffer.slice(scamBuffer.byteOffset, scamBuffer.byteOffset + scamBuffer.byteLength),
    });

    const mockClient = {
        channels: {
            fetch: async (id) => {
                if (id === '123456789012345678') {
                    return {
                        id,
                        send: async (payload) => {
                            modLogEmbedSent = payload;
                            return payload;
                        },
                    };
                }
                return null;
            },
        },
    };

    try {
        const mockMessage = {
            id: 'msg_scam_777',
            createdTimestamp: 1710000000000,
            author: { bot: false, id: 'scammer_user_id', username: 'BadActor' },
            channel: {
                id: 'chan_public',
                name: 'general-chat',
                send: async (payload) => {
                    channelWarningSent = payload;
                    return {
                        delete: async () => {},
                    };
                },
            },
            attachments: new Map([
                ['1', { url: 'https://cdn.discordapp.com/attachments/test-scam.png', contentType: 'image/png', size: scamBuffer.length }]
            ]),
            delete: async () => {
                messageDeleted = true;
            },
        };

        const result = await scamShield.handleMessage(mockMessage, mockClient, {
            logChannelId: '123456789012345678',
            autoDeleteSeconds: 0,
        });

        assert.strictEqual(result.scanned, true);
        assert.strictEqual(result.detected, true);
        assert.strictEqual(result.deleted, true);
        assert.strictEqual(messageDeleted, true, 'Message should have been deleted');

        // Verify channel warning message
        assert.ok(channelWarningSent, 'Warning message should have been sent to channel');
        assert.ok(channelWarningSent.content.includes('automatically removed'));
        assert.ok(channelWarningSent.content.includes('matched a known scam/spam image'));
        assert.ok(!channelWarningSent.content.includes('pHash') && !channelWarningSent.content.includes('bf30c81dd90f44ec'), 'Must NOT expose internal algorithm or hash');

        // Verify mod log embed
        assert.ok(modLogEmbedSent, 'Mod log embed should have been sent');
        const embed = modLogEmbedSent.embeds[0];
        assert.ok(embed.title.includes('ScamShield'));
        const fields = embed.fields;
        assert.ok(fields.some(f => f.name === 'User' && f.value.includes('scammer_user_id')));
        assert.ok(fields.some(f => f.name === 'Channel' && f.value.includes('chan_public')));
        assert.ok(fields.some(f => f.name === 'Message ID' && f.value.includes('msg_scam_777')));
        assert.ok(fields.some(f => f.name === 'Detection Type'));
        assert.ok(fields.some(f => f.name === 'Action Taken' && f.value.includes('Message Deleted')));
    } finally {
        global.fetch = originalFetch;
    }
});

test('ScamShield: 10-second Periodic Channel Scanner sweeps and detects scam attachments', async () => {
    const scamBuffer = fs.readFileSync(path.join(ATTACHED_DIR, testImages[0]));
    const originalFetch = global.fetch;

    global.fetch = async () => ({
        ok: true,
        headers: new Headers({ 'content-length': String(scamBuffer.length) }),
        arrayBuffer: async () => scamBuffer.buffer.slice(scamBuffer.byteOffset, scamBuffer.byteOffset + scamBuffer.byteLength),
    });

    let messageDeleted = false;

    try {
        const mockGuildChannel = {
            id: 'chan_auto_scan',
            isTextBased: () => true,
            messages: {
                fetch: async () => new Map([
                    ['msg_auto_1', {
                        id: 'msg_auto_1',
                        author: { bot: false, id: 'actor_1', username: 'SuspiciousUser' },
                        attachments: new Map([
                            ['att_1', { url: 'https://cdn.discordapp.com/scam.png', contentType: 'image/png', size: scamBuffer.length }]
                        ]),
                        delete: async () => { messageDeleted = true; },
                        channel: {
                            id: 'chan_auto_scan',
                            send: async () => ({ delete: async () => {} }),
                        },
                    }]
                ]),
            },
        };

        const mockClient = {
            guilds: {
                cache: new Map([
                    ['guild_1', {
                        channels: {
                            cache: new Map([
                                ['chan_auto_scan', mockGuildChannel]
                            ]),
                        },
                    }]
                ]),
            },
        };

        const scanResult = await scamShield.scanRecentGuildChannels(mockClient, null);
        assert.strictEqual(scanResult.channelsScanned, 1);
        assert.strictEqual(scanResult.messagesScanned, 1);
        assert.strictEqual(scanResult.scamDetectedCount, 1);
        assert.strictEqual(messageDeleted, true, 'Periodic scanner should delete scam image message');

        // Test startPeriodicScanner initializes timer
        const timer = scamShield.startPeriodicScanner(mockClient, null, 10000);
        assert.ok(timer, 'startPeriodicScanner should return active timer');
        clearInterval(timer);
    } finally {
        global.fetch = originalFetch;
    }
});

after(async () => {
    await scamShield.terminateLocalOcr();
});

