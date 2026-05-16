// src/services/aiService.js
// Gemini primary → Cohere fallback. Both have free tiers.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { CohereClient } = require('cohere-ai');

let gemini = null;
let cohere = null;

function initAI() {
  if (process.env.GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    gemini = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); // free tier
  }
  if (process.env.COHERE_API_KEY) {
    cohere = new CohereClient({ token: process.env.COHERE_API_KEY });
  }
}

// ── Language Detection ────────────────────────────────────────────
function detectLanguage(text) {
  const hindiPattern = /[\u0900-\u097F]/;
  const hinglishWords = /\b(hai|hain|kya|nahi|nahin|theek|acha|ok|bhai|yaar|karo|bata|mujhe|mera|tera|aap|tum|hum|abhi|kal|aaj|booking|chahiye|kab|kaise|kitna|kitne)\b/i;

  if (hindiPattern.test(text)) return 'hindi';
  if (hinglishWords.test(text)) return 'hinglish';
  return 'english';
}

// ── Intent Classification (rule-based, fast, no API cost) ─────────
function classifyIntent(text, keywords = {}) {
  const t = text.toLowerCase().trim();

  const intentPatterns = {
    greet: /^(hi|hello|hey|hii|helo|namaste|namaskar|hy|good morning|good afternoon|good evening|start|\/start)/i,
    book: /(book|appointment|schedule|slot|fix|set up|reserve|reservation|demo|trial|class|session|table|consult)/i,
    cancel: /(cancel|cancellation|reschedule|rebook|postpone|change booking)/i,
    status: /(my appointment|my booking|check|status|confirm|details|when is|what time)/i,
    services: /(services|what do you offer|treatments|list|menu|options|what|price|fees|cost|charges|rate)/i,
    hours: /(timing|hours|time|open|close|when|schedule|working|available)/i,
    location: /(address|location|where|directions|map|how to reach|come|find)/i,
    help: /(help|support|assist|problem|issue|complaint|not working)/i,
    bye: /(bye|goodbye|ok thanks|thank you|thanks|done|noted|great|perfect)/i,
    yes: /^(yes|yeah|yep|ha|haan|ok|okay|sure|confirm|correct|right|1)$/i,
    no: /^(no|nope|nahi|na|cancel|0)$/i
  };

  // Check custom keywords from client config
  if (keywords.cancel && new RegExp(keywords.cancel, 'i').test(t)) return 'cancel';
  if (keywords.appointment && new RegExp(keywords.appointment, 'i').test(t)) return 'book';

  for (const [intent, pattern] of Object.entries(intentPatterns)) {
    if (pattern.test(t)) return intent;
  }

  // Number detection for menu selections
  const num = parseInt(t);
  if (!isNaN(num) && num > 0 && num <= 20) return `select_${num}`;

  return 'unknown';
}

// ── AI Response Generator ────────────────────────────────────────
async function generateAIResponse(systemPrompt, userMessage, conversationHistory = []) {
  const messages = conversationHistory.slice(-6); // last 6 messages for context

  // Try Gemini first
  if (gemini) {
    try {
      const fullPrompt = `${systemPrompt}

Conversation so far:
${messages.map(m => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content}`).join('\n')}

Customer: ${userMessage}
Assistant:`;

      const result = await gemini.generateContent(fullPrompt);
      const text = result.response.text().trim();
      if (text) return { text, source: 'gemini' };
    } catch (err) {
      console.log('[AI] Gemini failed, trying Cohere:', err.message);
    }
  }

  // Fallback to Cohere
  if (cohere) {
    try {
      const chatHistory = messages.map(m => ({
        role: m.role === 'user' ? 'USER' : 'CHATBOT',
        message: m.content
      }));

      const response = await cohere.chat({
        model: 'command-r', // free tier
        preamble: systemPrompt,
        chatHistory,
        message: userMessage,
        maxTokens: 300
      });

      const text = response.text.trim();
      if (text) return { text, source: 'cohere' };
    } catch (err) {
      console.log('[AI] Cohere also failed:', err.message);
    }
  }

  return null; // both failed, use rule-based fallback
}

// ── Context-aware AI for complex queries (FAQ / free-form) ────────
async function getContextualReply(clientConfig, userMessage, lang) {
  const businessInfo = `
You are ${clientConfig.botName}, a WhatsApp assistant for "${clientConfig.businessName || 'this business'}".
Business type: ${clientConfig.businessType || 'general business'}
Services: ${(clientConfig.services || []).map(s => `${s.name} (₹${s.fee}, ${s.duration}min)`).join(', ')}
Working hours: ${clientConfig.workingHours?.start} to ${clientConfig.workingHours?.end}

FAQs:
${(clientConfig.faqs || []).map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n')}

RULES:
- Reply in ${lang === 'hinglish' ? 'Hinglish (mix of Hindi and English naturally)' : lang === 'hindi' ? 'Hindi' : 'English'}
- Be warm, helpful, and concise (max 3 lines)
- If you don't know, say "Please contact us directly for this"
- Never make up appointment details or fees
- Use emojis sparingly (1-2 per message max)
- Always end by offering to help with anything else
`;

  const result = await generateAIResponse(businessInfo, userMessage);
  return result ? result.text : null;
}

module.exports = { initAI, detectLanguage, classifyIntent, generateAIResponse, getContextualReply };
