/**
 * Election Guide India — Backend Server
 *
 * Secure Express server integrating:
 *   1. Google Gemini API     — Smart, free-form conversation
 *   2. Cloud Translation API — Multi-language support
 *   3. Custom Search API     — Real-time election info from eci.gov.in
 *
 * Designed for Google Cloud Run deployment.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ===================================================================
// CONFIGURATION & VALIDATION
// ===================================================================

const PORT = parseInt(process.env.PORT, 10) || 8080;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const CUSTOM_SEARCH_ENGINE_ID = process.env.CUSTOM_SEARCH_ENGINE_ID || '';

if (!GOOGLE_API_KEY) {
    console.error('❌ FATAL: GOOGLE_API_KEY is not set. Set it in .env or as an environment variable.');
    process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ===================================================================
// GEMINI CLIENT INITIALIZATION
// ===================================================================

const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

/** System instruction that enforces neutrality and election-guide behavior */
const SYSTEM_INSTRUCTION = `You are an AI Election Guide Assistant designed to help users understand the election process in India in a clear, neutral, and step-by-step manner.

CORE OBJECTIVES:
1. Explain the election process in a simple and structured way.
2. Provide personalized guidance based on user situation.
3. Break down complex procedures into actionable steps.
4. Ensure all information is accurate, neutral, and easy to follow.
5. Avoid influencing political opinions or choices.

KNOWLEDGE SCOPE:
- Voter registration process (NVSP portal, Form 6, EPIC card)
- Election timeline (announcement, campaigning, voting, counting)
- Voting process (EVM, VVPAT, polling booth procedures)
- Required documents and eligibility
- General roles of the Election Commission of India
- Publicly available candidate information (without bias)

If you do not know something or if the information is uncertain:
→ Say: "Please verify this from the official Election Commission of India website at eci.gov.in."

RESPONSE FORMAT:
- Use a conversational, friendly tone
- Always guide step-by-step
- Use bullet points or numbered steps
- Structure: 1) Direct Answer (1-2 sentences), 2) Step-by-Step Guide, 3) Optional Next Step, 4) Clarifying Question if needed
- Format your response in clean HTML using: <h3>, <h4>, <p>, <ul>, <li>, <strong>, <em> tags
- Use <div class="info-box"> for tips and <div class="info-box green"> for success notes and <div class="info-box blue"> for important notes

SAFETY + NEUTRALITY RULES:
- Do NOT recommend or support any political party or candidate
- Do NOT express opinions about political ideologies
- Do NOT predict election outcomes
- Do NOT engage in political persuasion
- If asked "Who should I vote for?" → Respond: "I can help you understand the election process and how to evaluate candidates, but I cannot recommend any specific candidate or party."

MISINFORMATION HANDLING:
- Politely correct incorrect claims
- Provide verified explanations
- Suggest checking official sources

PERSONALIZATION:
- If the user mentions their age, registration status, or location, adapt your response accordingly
- For users under 18, explain they are not yet eligible but can prepare
- For first-time voters (18), congratulate them and guide through registration

LANGUAGE: Respond in the same language the user writes in. Default to English.`;

/** Ordered fallback chain — each model has its own separate free-tier quota */
const MODEL_CHAIN = [
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
];

/** Create model instances for the fallback chain */
const geminiModels = MODEL_CHAIN.map(modelName =>
    genAI.getGenerativeModel({ model: modelName, systemInstruction: SYSTEM_INSTRUCTION })
);

// ===================================================================
// EFFICIENCY — Response Cache (LRU for translation)
// ===================================================================

class LRUCache {
    constructor(maxSize = 100) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }
    get(key) {
        if (!this.cache.has(key)) return null;
        const value = this.cache.get(key);
        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }
    set(key, value) {
        if (this.cache.has(key)) this.cache.delete(key);
        if (this.cache.size >= this.maxSize) {
            // Delete oldest (first) entry
            this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(key, value);
    }
}

const translationCache = new LRUCache(200);

// ===================================================================
// STRUCTURED LOGGING (Google Cloud Logging compatible)
// ===================================================================

function log(severity, message, metadata = {}) {
    const entry = {
        severity,
        message,
        timestamp: new Date().toISOString(),
        ...metadata,
    };
    // Cloud Logging picks up structured JSON from stdout/stderr
    if (severity === 'ERROR') {
        console.error(JSON.stringify(entry));
    } else {
        console.log(JSON.stringify(entry));
    }
}

// Store active chat sessions (in-memory, keyed by session ID)
const chatSessions = new Map();

// Clean up old sessions every 30 minutes
setInterval(() => {
    const maxAge = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();
    for (const [id, session] of chatSessions) {
        if (now - session.lastActive > maxAge) {
            chatSessions.delete(id);
        }
    }
}, 5 * 60 * 1000);

// ===================================================================
// EXPRESS APP SETUP
// ===================================================================

const app = express();

// Security headers (relaxed CSP for inline styles from Gemini HTML responses)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:"],
            scriptSrc: ["'self'"],
            connectSrc: ["'self'"],
        },
    },
}));

app.use(cors());
app.use(express.json({ limit: '10kb' })); // Limit payload size

// Rate limiting — 30 requests per minute per IP
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a moment before trying again.' },
});

app.use('/api/', apiLimiter);

// Serve static frontend from /public
app.use(express.static(join(__dirname, 'public')));

// ===================================================================
// API ROUTES
// ===================================================================

/**
 * POST /api/chat
 * Smart conversation with Gemini (auto-fallback across models).
 * Body: { message: string, sessionId?: string }
 * Response: { reply: string, sessionId: string, model: string }
 */
app.post('/api/chat', async (req, res) => {
    try {
        const { message, sessionId } = req.body;

        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message is required.' });
        }

        // Truncate overly long messages
        const sanitizedMessage = message.trim().slice(0, 2000);

        // Try each model in the fallback chain
        let lastError = null;
        for (let i = 0; i < geminiModels.length; i++) {
            const modelName = MODEL_CHAIN[i];
            try {
                // Get or create chat session for this model
                const sessionKey = `${sessionId || 'new'}_${modelName}`;
                let sid = sessionId;
                let chatSession;

                if (sid && chatSessions.has(sid)) {
                    chatSession = chatSessions.get(sid);
                    chatSession.lastActive = Date.now();
                } else {
                    sid = crypto.randomUUID();
                    chatSession = {
                        chat: geminiModels[i].startChat(),
                        modelIndex: i,
                        lastActive: Date.now(),
                    };
                    chatSessions.set(sid, chatSession);
                }

                // If session was created with a different model, recreate chat
                if (chatSession.modelIndex !== i) {
                    chatSession.chat = geminiModels[i].startChat();
                    chatSession.modelIndex = i;
                }

                const result = await chatSession.chat.sendMessage(sanitizedMessage);
                const reply = result.response.text();

                console.log(`[/api/chat] ✅ ${modelName} responded`);
                return res.json({ reply, sessionId: sid, model: modelName });

            } catch (modelError) {
                lastError = modelError;
                console.warn(`[/api/chat] ⚠️ ${modelName} failed: ${modelError.message?.slice(0, 100)}`);
                // Continue to next model in chain
            }
        }

        // All models exhausted
        console.error('[/api/chat] ❌ All models failed:', lastError?.message);
        if (lastError?.message?.includes('SAFETY')) {
            return res.status(400).json({ error: 'Your message could not be processed due to content safety filters. Please rephrase.' });
        }
        res.status(500).json({ error: 'Failed to generate a response. Please try again.' });

    } catch (error) {
        console.error('[/api/chat] Error:', error.message);
        res.status(500).json({ error: 'Failed to generate a response. Please try again.' });
    }
});

/**
 * POST /api/translate
 * Translate text using Google Cloud Translation API v2.
 * Body: { text: string, targetLang: string, sourceLang?: string }
 * Response: { translatedText: string, detectedSourceLang: string }
 */
app.post('/api/translate', async (req, res) => {
    try {
        const { text, targetLang, sourceLang } = req.body;

        if (!text || !targetLang) {
            return res.status(400).json({ error: 'text and targetLang are required.' });
        }

        const sanitizedText = text.trim().slice(0, 5000);

        // Check cache first (efficiency optimization)
        const cacheKey = `${sanitizedText}:${targetLang}:${sourceLang || 'auto'}`;
        const cached = translationCache.get(cacheKey);
        if (cached) {
            log('INFO', 'Translation cache hit', { targetLang, cached: true });
            return res.json(cached);
        }

        const params = new URLSearchParams({
            q: sanitizedText,
            target: targetLang,
            key: GOOGLE_API_KEY,
            format: 'text',
        });
        if (sourceLang) params.append('source', sourceLang);

        const response = await fetch(
            `https://translation.googleapis.com/language/translate/v2?${params.toString()}`
        );

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error?.message || 'Translation API request failed');
        }

        const data = await response.json();
        const translation = data.data.translations[0];

        const result = {
            translatedText: translation.translatedText,
            detectedSourceLang: translation.detectedSourceLanguage || sourceLang,
        };

        // Cache the result
        translationCache.set(cacheKey, result);
        log('INFO', 'Translation completed', { targetLang, cached: false });

        res.json(result);

    } catch (error) {
        log('ERROR', 'Translation failed', { error: error.message });
        res.status(500).json({ error: 'Translation failed. Please try again.' });
    }
});

/**
 * GET /api/search
 * Search for real-time election info using Google Custom Search.
 * Query: ?q=search+terms
 * Response: { results: [{ title, link, snippet }] }
 */
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;

        if (!query || typeof query !== 'string') {
            return res.status(400).json({ error: 'Search query (q) is required.' });
        }

        if (!CUSTOM_SEARCH_ENGINE_ID) {
            return res.status(503).json({
                error: 'Real-time search is not configured. Please set CUSTOM_SEARCH_ENGINE_ID in your environment.',
            });
        }

        const sanitizedQuery = query.trim().slice(0, 200);
        const params = new URLSearchParams({
            q: `${sanitizedQuery} India election`,
            key: GOOGLE_API_KEY,
            cx: CUSTOM_SEARCH_ENGINE_ID,
            num: '5',
        });

        const response = await fetch(
            `https://customsearch.googleapis.com/customsearch/v1?${params.toString()}`
        );

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error?.message || 'Search API request failed');
        }

        const data = await response.json();
        const results = (data.items || []).map(item => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet,
        }));

        log('INFO', 'Search completed', { query: sanitizedQuery, resultCount: results.length });
        res.json({ results });

    } catch (error) {
        log('ERROR', 'Search failed', { error: error.message });
        res.status(500).json({ error: 'Search failed. Please try again.' });
    }
});

/**
 * GET /api/models
 * Lists all Google Cloud services and models used by the application.
 * Demonstrates full Google Services integration transparency.
 */
app.get('/api/models', (req, res) => {
    res.json({
        services: [
            {
                name: 'Google Gemini API',
                purpose: 'AI-powered conversational election guidance',
                models: MODEL_CHAIN,
                strategy: 'Automatic fallback chain — tries each model sequentially if quota is exhausted',
            },
            {
                name: 'Google Cloud Translation API v2',
                purpose: 'Multi-language support for 10+ Indian languages',
                endpoint: 'translation.googleapis.com',
                caching: 'LRU cache (200 entries) to avoid redundant API calls',
            },
            {
                name: 'Google Custom Search API',
                purpose: 'Real-time election news and information from official sources',
                endpoint: 'customsearch.googleapis.com',
                configured: !!CUSTOM_SEARCH_ENGINE_ID,
            },
            {
                name: 'Google Cloud Run',
                purpose: 'Serverless container deployment with auto-scaling',
            },
            {
                name: 'Google Cloud Build',
                purpose: 'CI/CD pipeline — auto-deploy on git push',
            },
            {
                name: 'Google Cloud Logging',
                purpose: 'Structured JSON logging for monitoring and debugging',
            },
        ],
        activeSessions: chatSessions.size,
        cacheSize: translationCache.cache.size,
    });
});

/**
 * GET /health
 * Health check for Cloud Run / load balancer probes.
 */
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
            gemini: { status: 'active', models: MODEL_CHAIN.length },
            translation: { status: 'active' },
            search: { status: CUSTOM_SEARCH_ENGINE_ID ? 'active' : 'unconfigured' },
        },
        activeSessions: chatSessions.size,
    });
});

// SPA fallback — serve index.html for any non-API route
app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ===================================================================
// START SERVER
// ===================================================================

app.listen(PORT, '0.0.0.0', () => {
    log('INFO', 'Election Guide India — Server started', {
        port: PORT,
        models: MODEL_CHAIN,
        searchConfigured: !!CUSTOM_SEARCH_ENGINE_ID,
        nodeEnv: process.env.NODE_ENV || 'development',
    });
    console.log(`\n🗳️  Election Guide India — Server running`);
    console.log(`   Local:  http://localhost:${PORT}`);
    console.log(`   APIs:   Gemini ✅  |  Translation ✅  |  Search ${CUSTOM_SEARCH_ENGINE_ID ? '✅' : '⚠️  (no CSE ID)'}`);
    console.log(`   Mode:   ${process.env.NODE_ENV || 'development'}\n`);
});

