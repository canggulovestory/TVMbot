// integrations/marketing.js — AI Content Generation for Villa Marketing

const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CONTENT_PROMPTS = {
  instagram: (villaName, details) => `Create an engaging Instagram caption for "${villaName}" villa.
Details: ${JSON.stringify(details)}
Include: 3-5 relevant hashtags, emoji, call to action. Keep it under 200 words. Tone: aspirational, warm, luxurious.`,

  facebook: (villaName, details) => `Create a Facebook post for "${villaName}" villa.
Details: ${JSON.stringify(details)}
Include: engaging opening, key features, call to action, 2-3 hashtags. 100-150 words.`,

  airbnb: (villaName, details) => `Write an Airbnb listing description for "${villaName}" villa.
Details: ${JSON.stringify(details)}
Structure: Opening hook (1 sentence), Space description (2-3 sentences), Key amenities (3-4 bullet points), Location highlights (1-2 sentences), Guest experience closing. Professional and inviting tone.`,

  email_promo: (villaName, details) => `Write a promotional email for "${villaName}" villa.
Details: ${JSON.stringify(details)}
Include: Subject line, greeting, villa highlights, special offer if any, CTA button text, sign-off. Professional but warm tone.`,

  welcome_letter: (villaName, details) => `Write a guest welcome letter for "${villaName}" villa.
Guest details: ${JSON.stringify(details)}
Include: Warm welcome, check-in instructions, house rules summary (friendly tone), local recommendations, emergency contacts placeholder, sign-off from host.`,

  review_request: (villaName, details) => `Write a review request message for a guest who stayed at "${villaName}".
Details: ${JSON.stringify(details)}
Short, friendly message asking for an honest review. Mention it helps other travelers. Include placeholder for review link. Under 100 words.`
};

async function generateMarketingContent(villaName, contentType = 'instagram', details = {}) {
  const promptFn = CONTENT_PROMPTS[contentType];
  if (!promptFn) {
    return { error: `Unknown content type: ${contentType}. Available: ${Object.keys(CONTENT_PROMPTS).join(', ')}` };
  }

  try {
    const response = await claude.messages.create({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: promptFn(villaName, details)
      }]
    });

    const content = response.content.find(b => b.type === 'text')?.text || '';
    return {
      villaName,
      contentType,
      content,
      wordCount: content.split(/\s+/).length,
      generatedAt: new Date().toISOString()
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { generateMarketingContent };
