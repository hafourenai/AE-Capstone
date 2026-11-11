export class WAHAClient {
  constructor(baseUrl, apiKey, session) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.session = session;
  }

  async sendMessage(chatId, text) {
    const [localPart, domain] = chatId.includes('@') ? chatId.split('@') : [chatId, 'c.us'];
    const normalizedDomain = domain === 's.whatsapp.net' ? 'c.us' : domain;
    const normalizedChatId = `${localPart.split(':')[0]}@${normalizedDomain}`;
    const response = await fetch(`${this.baseUrl}/api/sendText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
      },
      body: JSON.stringify({
        session: this.session,
        chatId: normalizedChatId,
        text,
      }),
    });
    if (!response.ok) {
      throw new Error(`WAHA API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  async checkHealth() {
    const response = await fetch(`${this.baseUrl}/api/sessions`, {
      headers: { 'X-Api-Key': this.apiKey },
    });
    if (!response.ok) throw new Error(`WAHA health check failed: ${response.status}`);
    return response.json();
  }
}
