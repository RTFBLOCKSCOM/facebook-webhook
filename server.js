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

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR);

// Config file path
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Load or create config
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) { console.error('Load config error:', e); }
  return {
    verifyToken: '',
    pageAccessToken: '',
    openrouterKey: '',
    aiModel: 'openai/gpt-5.2'
  };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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

function searchKnowledge(query) {
  const kbFiles = loadKnowledgeFiles();
  const relevant = [];
  
  for (const file of kbFiles) {
    // Simple keyword matching
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
async function generateAIResponse(userMessage, kbContext) {
  const config = loadConfig();
  
  if (!config.openrouterKey) {
    return { error: 'OpenRouter API key not configured' };
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
        model: config.aiModel || 'openai/gpt-5.2',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${config.openrouterKey}`,
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

// ==================== ROUTES ====================

// Dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// API: Config
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  // Mask sensitive data
  config.pageAccessToken = config.pageAccessToken ? '***' + config.pageAccessToken.slice(-4) : '';
  config.openrouterKey = config.openrouterKey ? '***' + config.openrouterKey.slice(-4) : '';
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  const currentConfig = loadConfig();
  
  // Only update if value is not masked
  if (!newConfig.verifyToken.startsWith('***')) currentConfig.verifyToken = newConfig.verifyToken;
  if (!newConfig.pageAccessToken.startsWith('***')) currentConfig.pageAccessToken = newConfig.pageAccessToken;
  if (!newConfig.openrouterKey.startsWith('***')) currentConfig.openrouterKey = newConfig.openrouterKey;
  currentConfig.aiModel = newConfig.aiModel;
  
  saveConfig(currentConfig);
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
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  
  const kbContext = searchKnowledge(message);
  const result = await generateAIResponse(message, kbContext);
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

// Facebook Webhook Verification (GET)
app.get('/webhook', (req, res) => {
  const config = loadConfig();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  logMessage('VERIFY', { mode, tokenMatch: token === config.verifyToken });

  if (mode === 'subscribe' && token === config.verifyToken) {
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
  const config = loadConfig();

  logMessage('RECEIVED', body);

  // Must send 200 within 20 seconds
  res.status(200).send('OK');

  // Handle messages
  if (body.object === 'page') {
    for (const entry of body.entry) {
      for (const messaging of entry.messaging) {
        const senderId = messaging.sender.id;
        const message = messaging.message;
        
        // Only handle text messages
        if (message && message.text) {
          const userText = message.text;
          logMessage('MESSAGE', { senderId, text: userText });
          
          // Generate AI response with knowledge base
          const kbContext = searchKnowledge(userText);
          const aiResult = await generateAIResponse(userText, kbContext);
          
          if (aiResult.response) {
            // Send auto-reply
            await sendAutoReply(senderId, aiResult.response, config.pageAccessToken);
          } else if (aiResult.error) {
            await sendAutoReply(senderId, "Thanks for your message! We'll get back to you soon. 😊", config.pageAccessToken);
            logMessage('ERROR', { msg: aiResult.error });
          }
        }
      }
    }
  }
});

// Send auto-reply to user
async function sendAutoReply(senderId, replyText, pageAccessToken) {
  if (!pageAccessToken || pageAccessToken === 'YOUR_PAGE_ACCESS_TOKEN' || pageAccessToken.startsWith('***')) {
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Facebook Auto-Reply Bot running on port ${PORT}`);
  console.log(`📋 Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`🔒 Webhook URL: http://localhost:${PORT}/webhook`);
});
