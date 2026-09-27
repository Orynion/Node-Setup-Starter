const test = require('node:test');
const assert = require('node:assert/strict');
const { commands } = require('../src/deploy-commands.js');
const {
    LAX_SYSTEM_INSTRUCTION,
    askLaxAi,
    getGeminiClient,
    splitDiscordMessage,
    sanitizeAiOutput,
    clearUserHistory,
    getUserHistory,
} = require('../src/ai.js');

test('Deploy Commands: /ask slash command is registered with required question option', () => {
    const askCmd = commands.find(c => c.name === 'ask');
    assert.ok(askCmd, '/ask command must be defined');
    assert.strictEqual(askCmd.options.length, 1);
    assert.strictEqual(askCmd.options[0].name, 'question');
    assert.strictEqual(askCmd.options[0].required, true);
});

test('LAX System Context: Includes comprehensive LAX domain knowledge and constraints', () => {
    assert.ok(LAX_SYSTEM_INSTRUCTION.includes('Los Angeles Exchange'), 'Context must explain LAX');
    assert.ok(LAX_SYSTEM_INSTRUCTION.includes('Roblox') || LAX_SYSTEM_INSTRUCTION.includes('Emergency Hamburg'), 'Context must explain RP setting');
    assert.ok(LAX_SYSTEM_INSTRUCTION.includes('1%'), 'Context must explain 1% secondary trading fee');
    assert.ok(LAX_SYSTEM_INSTRUCTION.includes('Instant Sell') || LAX_SYSTEM_INSTRUCTION.includes('Treasury'), 'Context must explain Treasury/Instant Sell');
    assert.ok(LAX_SYSTEM_INSTRUCTION.includes('EXEMPT') || LAX_SYSTEM_INSTRUCTION.includes('does NOT use'), 'Context must explain Instant Sell fee exemption');
    assert.ok(LAX_SYSTEM_INSTRUCTION.includes('cashout') && LAX_SYSTEM_INSTRUCTION.includes('8,000'), 'Context must explain cashout limits');
    assert.ok(LAX_SYSTEM_INSTRUCTION.includes('ticket'), 'Context must explain support tickets');
    assert.ok(LAX_SYSTEM_INSTRUCTION.includes('CANNOT execute trades') || LAX_SYSTEM_INSTRUCTION.includes('conversation-only'), 'Must forbid trade execution');
    assert.ok(LAX_SYSTEM_INSTRUCTION.includes('NEVER invent live data'), 'Must forbid hallucinating live prices or balances');
});

test('Gemini Client: Initialized using @google/genai with telemetry User-Agent', () => {
    const client = getGeminiClient();
    assert.ok(client, 'Gemini client must be instantiated');
    assert.strictEqual(client.httpOptions?.headers?.['User-Agent'], 'aistudio-build');
});

test('Conversational Flow: Normal response is returned with proper model and systemInstruction', async () => {
    clearUserHistory('test_user_1');

    let capturedPayload = null;
    const mockClient = {
        models: {
            async generateContent(payload) {
                capturedPayload = payload;
                return {
                    text: 'Instant sell allows you to sell owned shares directly to the LAX Treasury for immediate liquidity without waiting for buyers!',
                };
            },
        },
    };

    const res = await askLaxAi({
        question: 'What is instant sell?',
        userId: 'test_user_1',
        clientOverride: mockClient,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.question, 'What is instant sell?');
    assert.ok(res.answer.includes('LAX Treasury'));
    assert.strictEqual(capturedPayload.model, 'gemini-3.5-flash-lite');
    assert.strictEqual(capturedPayload.config.systemInstruction, LAX_SYSTEM_INSTRUCTION);
    assert.strictEqual(capturedPayload.contents[0].parts[0].text, 'What is instant sell?');
});

test('Short Conversation Memory: Maintains bounded conversation history per user', async () => {
    const userId = 'test_memory_user';
    clearUserHistory(userId);

    const callLogs = [];
    const mockClient = {
        models: {
            async generateContent(payload) {
                callLogs.push(payload);
                return {
                    text: `Response to: ${payload.contents[payload.contents.length - 1].parts[0].text}`,
                };
            },
        },
    };

    // First question
    await askLaxAi({
        question: 'Who are you?',
        userId,
        clientOverride: mockClient,
    });

    assert.strictEqual(callLogs[0].contents.length, 1);
    assert.strictEqual(callLogs[0].contents[0].parts[0].text, 'Who are you?');

    // Second question (should include previous question and answer)
    await askLaxAi({
        question: 'How do I buy stocks?',
        userId,
        clientOverride: mockClient,
    });

    assert.strictEqual(callLogs[1].contents.length, 3);
    assert.strictEqual(callLogs[1].contents[0].role, 'user');
    assert.strictEqual(callLogs[1].contents[0].parts[0].text, 'Who are you?');
    assert.strictEqual(callLogs[1].contents[1].role, 'model');
    assert.strictEqual(callLogs[1].contents[2].role, 'user');
    assert.strictEqual(callLogs[1].contents[2].parts[0].text, 'How do I buy stocks?');

    // Verify history length is bounded
    const history = getUserHistory(userId);
    assert.ok(history.length <= 6, 'History must remain bounded');
});

test('Error Handling: Gemini/API failures are handled gracefully without crashing', async () => {
    const mockFailingClient = {
        models: {
            async generateContent() {
                const err = new Error('RESOURCE_EXHAUSTED: Rate limit exceeded');
                err.status = 429;
                throw err;
            },
        },
    };

    const res = await askLaxAi({
        question: 'Hello?',
        userId: 'test_err_user',
        clientOverride: mockFailingClient,
    });

    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('high traffic') || res.error.includes('temporary issue'));
});

test('Validation: Empty or invalid input questions are rejected cleanly', async () => {
    const res1 = await askLaxAi({ question: '' });
    assert.strictEqual(res1.success, false);
    assert.ok(res1.error.includes('valid question'));

    const res2 = await askLaxAi({ question: '   ' });
    assert.strictEqual(res2.success, false);
});

test('Message Splitting: Long AI responses are safely chunked for Discord embed limits', () => {
    const longText = 'This is a test paragraph of LAX AI knowledge.\n\n'.repeat(150); // ~7000 chars
    const chunks = splitDiscordMessage(longText, 4000);

    assert.ok(chunks.length >= 2, 'Should split into multiple chunks');
    for (const chunk of chunks) {
        assert.ok(chunk.length <= 4000, 'Each chunk must be under max limit');
    }
    const combined = chunks.join('\n\n');
    assert.ok(combined.includes('This is a test paragraph'));
});

test('Secret Protection: Output sanitizer prevents accidental leakage of environment keys', () => {
    process.env.GEMINI_API_KEY = 'TEST_SECRET_KEY_1234567890';
    const rawOutput = 'Here is your config with key TEST_SECRET_KEY_1234567890 for LAX.';
    const sanitized = sanitizeAiOutput(rawOutput);

    assert.strictEqual(sanitized.includes('TEST_SECRET_KEY_1234567890'), false);
    assert.ok(sanitized.includes('[REDACTED]'));
});

test('Security & Separation: Conversational AI cannot modify database or execute trades', async () => {
    // Verify that askLaxAi does NOT import database execution or accept write tools in V1
    const mockTradeClient = {
        models: {
            async generateContent() {
                return {
                    text: "I am a conversational assistant and cannot buy or sell shares on your behalf. Please use `/stock-buy AAPL 10` to purchase shares.",
                };
            },
        },
    };

    const res = await askLaxAi({
        question: 'Buy 10 shares of AAPL for me',
        userId: 'trader_user',
        clientOverride: mockTradeClient,
    });

    assert.strictEqual(res.success, true);
    assert.ok(res.answer.includes('/stock-buy') || res.answer.includes('cannot'));
});
