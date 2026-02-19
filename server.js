const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ verify: (req, res, buf) => {
  req.rawBody = buf;
}}));
app.use(express.static('public'));

// Configuration
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const KNOWLEDGE_DIR = path.join(DATA_DIR, 'knowledge');
const PAGES_FILE = path.join(DATA_DIR, 'pages.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR);

// Load pages configuration
function loadPages() {
  try {
    if (fs.existsSync(PAGES_FILE)) {
      return JSON.parse(fs.readFileSync(PAGES_FILE, 'utf8'));
    }
  } catch (e) { console.error('Load pages error:', e); }
  return [];
}

function savePages(pages) {
  fs.writeFileSync(PAGES_FILE, JSON.stringify(pages, null, 2));
}

// Load or create config
function loadGlobalConfig() {
  const configFile = path.join(DATA_DIR, 'config.json');
  try {
    if (fs.existsSync(configFile)) {
      return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
  } catch (e) { console.error('Load config error:', e); }
  return {
    defaultAiModel: 'openai/gpt-5.2',
    openrouterKey: ''
  };
}

function saveGlobalConfig(config) {
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2));
}

// Message log
const messageLog = [];

function logMessage(type, data) {
  const entry = { timestamp: new Date().toISOString(), type, data };
  messageLog.unshift(entry);
  if (messageLog.length > 100) messageLog.pop();
  console.log('[' + type + ']', JSON.stringify(data));
}

// Knowledge Base Functions
function loadKnowledgeFiles() {
  const files = [];
  try {
    const dirFiles = fs.readdirSync(KNOWLEDGE_DIR);
    for (const file of dirFiles) {
      if (file.endsWith('.md')) {
        const name = file.replace('.md', '');
        const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8');
        files.push({ name, content });
      }
    }
  } catch (e) { console.error('Load KB error:', e); }
  return files;
}

function searchKnowledge(query, pageId = null) {
  const kbFiles = loadKnowledgeFiles();
  const relevant = [];
  
  for (const file of kbFiles) {
    const lowerContent = file.content.toLowerCase();
    const lowerQuery = query.toLowerCase();
    
    if (lowerContent.includes(lowerQuery) || 
        lowerQuery.split(' ').some(word => word.length > 3 && lowerContent.includes(word))) {
      relevant.push(file.content);
    }
  }
  
  return relevant.join('\n\n---\n\n');
}

// OpenRouter AI Response
async function generateAIResponse(userMessage, kbContext, pageId) {
  const config = loadGlobalConfig();
  
  // Get page-specific settings
  const pages = loadPages();
  const page = pages.find(p => p.id === pageId);
  
  const apiKey = page?.openrouterKey || config.openrouterKey;
  const model = page?.aiModel || config.defaultAiModel || 'openai/gpt-5.2';
  
  if (!apiKey) {
    return { error: 'OpenRouter API key not configured for this page' };
  }
  
  const systemPrompt = `You are a helpful customer support bot for a Facebook Page. 
${kbContext ? `Use the following knowledge base to answer questions:\n\n${kbContext}\n\n` : ''}
Guidelines:
- Be friendly and helpful
- Keep responses concise
- If you don't know something, say you'll get back to the user
- Don't make up information
- Always be polite and professional`;

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://webhook.ramilflaviano.art',
          'X-Title': 'FB Auto-Reply Bot'
        },
        timeout: 30000
      }
    );
    
    return { 
      response: response.data.choices[0]?.message?.content || 'No response generated' 
    };
  } catch (error) {
    console.error('AI Error:', error.response?.data || error.message);
    return { 
      error: error.response?.data?.error?.message || error.message 
    };
  }
}

// Send auto-reply to user
async function sendAutoReply(senderId, replyText, pageAccessToken) {
  if (!pageAccessToken) {
    logMessage('ERROR', { msg: 'PAGE_ACCESS_TOKEN not configured' });
    return;
  }

  try {
    await axios.post(
      'https://graph.facebook.com/v18.0/me/messages',
      {
        recipient: { id: senderId },
        message: { text: replyText }
      },
      {
        params: { access_token: pageAccessToken },
        headers: { 'Content-Type': 'application/json' }
      }
    );
    logMessage('SENT', { senderId, reply: replyText });
  } catch (error) {
    logMessage('ERROR', { 
      msg: error.response?.data || error.message 
    });
  }
}

// ==================== ROUTES ====================

// Dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// API: Pages management
app.get('/api/pages', (req, res) => {
  const pages = loadPages();
  // Mask sensitive data
  const masked = pages.map(p => ({
    id: p.id,
    name: p.name,
    verifyToken: p.verifyToken ? '***' + p.verifyToken.slice(-4) : '',
    pageAccessToken: p.pageAccessToken ? '***' + p.pageAccessToken.slice(-4) : '',
    openrouterKey: p.openrouterKey ? '***' + p.openrouterKey.slice(-4) : '',
    aiModel: p.aiModel,
    knowledgeBase: p.knowledgeBase,
    enabled: p.enabled,
    createdAt: p.createdAt
  }));
  res.json(masked);
});

app.post('/api/pages', (req, res) => {
  const { name, verifyToken, pageAccessToken, openrouterKey, aiModel } = req.body;
  const pages = loadPages();
  
  const newPage = {
    id: 'page_' + Date.now(),
    name: name || 'New Page ' + (pages.length + 1),
    verifyToken: verifyToken || 'VERIFY_TOKEN_' + Math.random().toString(36).substring(7).toUpperCase(),
    pageAccessToken: pageAccessToken || '',
    openrouterKey: openrouterKey || '',
    aiModel: aiModel || 'openai/gpt-5.2',
    knowledgeBase: [],
    enabled: true,
    createdAt: new Date().toISOString()
  };
  
  pages.push(newPage);
  savePages(pages);
  res.json({ success: true, page: { id: newPage.id, name: newPage.name } });
});

app.put('/api/pages/:id', (req, res) => {
  const { id } = req.params;
  const { name, verifyToken, pageAccessToken, openrouterKey, aiModel, knowledgeBase, enabled } = req.body;
  const pages = loadPages();
  const index = pages.findIndex(p => p.id === id);
  
  if (index === -1) return res.status(404).json({ error: 'Page not found' });
  
  if (name) pages[index].name = name;
  if (verifyToken && !verifyToken.startsWith('***')) pages[index].verifyToken = verifyToken;
  if (pageAccessToken && !pageAccessToken.startsWith('***')) pages[index].pageAccessToken = pageAccessToken;
  if (openrouterKey && !openrouterKey.startsWith('***')) pages[index].openrouterKey = openrouterKey;
  if (aiModel) pages[index].aiModel = aiModel;
  if (knowledgeBase) pages[index].knowledgeBase = knowledgeBase;
  if (enabled !== undefined) pages[index].enabled = enabled;
  
  savePages(pages);
  res.json({ success: true });
});

app.delete('/api/pages/:id', (req, res) => {
  const { id } = req.params;
  let pages = loadPages();
  pages = pages.filter(p => p.id !== id);
  savePages(pages);
  res.json({ success: true });
});

// API: Global config
app.get('/api/config', (req, res) => {
  const config = loadGlobalConfig();
  res.json({
    defaultAiModel: config.defaultAiModel,
    openrouterKey: config.openrouterKey ? '***' + config.openrouterKey.slice(-4) : ''
  });
});

app.post('/api/config', (req, res) => {
  const { defaultAiModel, openrouterKey } = req.body;
  const config = loadGlobalConfig();
  
  if (defaultAiModel) config.defaultAiModel = defaultAiModel;
  if (openrouterKey && !openrouterKey.startsWith('***')) config.openrouterKey = openrouterKey;
  
  saveGlobalConfig(config);
  res.json({ success: true });
});

// API: Knowledge Base
app.get('/api/knowledge', (req, res) => {
  const files = loadKnowledgeFiles();
  res.json(files);
});

app.post('/api/knowledge', (req, res) => {
  const { name, content } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  
  const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '');
  const filePath = path.join(KNOWLEDGE_DIR, `${safeName}.md`);
  
  fs.writeFileSync(filePath, content || '');
  res.json({ success: true });
});

app.delete('/api/knowledge/:name', (req, res) => {
  const filePath = path.join(KNOWLEDGE_DIR, `${req.params.name}.md`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  res.json({ success: true });
});

// API: Test AI
app.post('/api/test', async (req, res) => {
  const { message, pageId } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  
  const kbContext = searchKnowledge(message, pageId);
  const result = await generateAIResponse(message, kbContext, pageId);
  res.json(result);
});

// API: Logs
app.get('/api/logs', (req, res) => {
  res.json(messageLog);
});

app.delete('/api/logs', (req, res) => {
  messageLog.length = 0;
  res.json({ success: true });
});

// ==================== FACEBOOK WEBHOOK ====================

// Facebook Webhook Verification (GET) - handles all pages
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Check against any page's verify token
  const pages = loadPages();
  const validToken = pages.some(p => p.verifyToken === token);

  logMessage('VERIFY', { mode, tokenMatch: validToken });

  if (mode === 'subscribe' && validToken) {
    console.log('WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    console.log('VERIFICATION_FAILED');
    res.sendStatus(403);
  }
});

// Facebook Webhook (POST) - incoming messages
app.post('/webhook', async (req, res) => {
  const body = req.body;

  logMessage('RECEIVED', body);

  // Must send 200 within 20 seconds
  res.status(200).send('OK');

  // Handle messages
  if (body.object === 'page') {
    for (const entry of body.entry) {
      const pageId = entry.id;
      
      // Find the page configuration
      const pages = loadPages();
      const pageConfig = pages.find(p => p.id === pageId || p.pageAccessToken?.includes(pageId));
      
      if (!pageConfig) {
        logMessage('ERROR', { msg: 'Page not configured: ' + pageId });
        continue;
      }
      
      if (!pageConfig.enabled) {
        logMessage('SKIP', { msg: 'Page disabled: ' + pageConfig.name });
        continue;
      }
      
      for (const messaging of entry.messaging) {
        const senderId = messaging.sender.id;
        const message = messaging.message;
        
        if (message && message.text) {
          const userText = message.text;
          logMessage('MESSAGE', { page: pageConfig.name, senderId, text: userText });
          
          // Generate AI response with knowledge base
          const kbContext = searchKnowledge(userText, pageConfig.id);
          const aiResult = await generateAIResponse(userText, kbContext, pageConfig.id);
          
          if (aiResult.response) {
            await sendAutoReply(senderId, aiResult.response, pageConfig.pageAccessToken);
          } else if (aiResult.error) {
            await sendAutoReply(senderId, "Thanks for your message! We'll get back to you soon. 😊", pageConfig.pageAccessToken);
            logMessage('ERROR', { msg: aiResult.error });
          }
        }
      }
    }
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Facebook Multi-Page Auto-Reply Bot running on port ${PORT}`);
  console.log(`📋 Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`🔒 Webhook URL: http://localhost:${PORT}/webhook`);
});
