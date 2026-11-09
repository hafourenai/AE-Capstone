export class WAHAClient {
  constructor(baseUrl, apiKey, session) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.session = session;
  }

  async sendMessage(chatId, text) {
    const response = await fetch(`${this.baseUrl}/api/sendText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
      },
      body: JSON.stringify({
        session: this.session,
        chatId: chatId.includes('@') ? chatId : `${chatId}@c.us`,
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
