export class WAHAClient {
  constructor(baseUrl, apiKey, session) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.session = session;
  }

  normalizeChatId(chatId) {
    const [localPart, domain] = chatId.includes('@') ? chatId.split('@') : [chatId, 'c.us'];
    const normalizedDomain = domain === 's.whatsapp.net' ? 'c.us' : domain;
    return `${localPart.split(':')[0]}@${normalizedDomain}`;
  }

  async _post(path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
      },
      body: JSON.stringify({ session: this.session, ...body }),
    });
    if (!response.ok) throw new Error(`WAHA API error: ${response.status} ${response.statusText}`);
    return response.json().catch(() => ({}));
  }

  async sendMessage(chatId, text) {
    return this._post('/api/sendText', { chatId: this.normalizeChatId(chatId), text });
  }

  async startTyping(chatId) {
    return this._post('/api/startTyping', { chatId: this.normalizeChatId(chatId) });
  }

  async stopTyping(chatId) {
    return this._post('/api/stopTyping', { chatId: this.normalizeChatId(chatId) });
  }

  async sendSeen(chatId) {
    return this._post('/api/sendSeen', { chatId: this.normalizeChatId(chatId) });
  }

  async checkHealth() {
    const response = await fetch(`${this.baseUrl}/api/sessions`, {
      headers: { 'X-Api-Key': this.apiKey },
    });
    if (!response.ok) throw new Error(`WAHA health check failed: ${response.status}`);
    return response.json();
  }
}
