import { util } from '@kit.ArkTS';
import { http } from '@kit.NetworkKit';

export class ApiError extends Error {
  status: number;
  payload: string;

  constructor(status: number, message: string, payload: string) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

interface ErrorResponse {
  error?: string;
}

interface LoginRequest {
  password: string;
}

// The password is never persisted. Cookies are scoped to this client/endpoint.
// Mutation calls are deliberately never retried: a lost send response may have
// committed a prompt to the PTY, so repeating it would duplicate the user's turn.
export class ApiClient {
  private endpoint: string = '';
  private cookie: string = '';
  private generation: number = 0;
  private active: boolean = false;
  onUnauthorized: () => void = () => {};

  invalidate(): void { this.generation++; this.cookie = ''; this.active = false; }
  connectionVersion(): number { return this.generation; }
  requireConnection(version: number): void { this.checkCurrent(version); }
  private checkCurrent(generation: number): void {
    if (!this.active || generation !== this.generation) throw new ApiError(499, 'Request superseded by a new connection.', '');
  }
  private checkAuthentication(status: number, generation: number, path: string): void {
    this.checkCurrent(generation);
    if (status === 401 && path !== '/api/login') {
      this.invalidate();
      this.onUnauthorized();
    }
  }

  configure(endpoint: string): void {
    const value = endpoint.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(value) || /:\/\/[^/]*@/.test(value)) {
      throw new Error('Enter an http:// or https:// server address without credentials, query, or fragment.');
    }
    if (this.endpoint !== value) {
      this.invalidate();
    }
    this.endpoint = value; this.active = true;
  }

  address(path: string): string {
    if (!path.startsWith('/api/')) throw new Error('Invalid media URL.');
    return this.endpoint + path;
  }
  authHeaders(): Record<string, string> { return { 'Cookie': this.cookie }; }

  async login(password: string): Promise<void> {
    this.generation++; this.cookie = '';
    const body: LoginRequest = { password: password };
    await this.request('/api/login', http.RequestMethod.POST, JSON.stringify(body));
  }

  async logout(): Promise<void> {
    const generation = this.generation;
    try {
      await this.request('/api/logout', http.RequestMethod.POST, '{}');
    } finally {
      if (generation === this.generation) this.invalidate();
    }
  }

  stream(path: string, receive: (event: string, data: string) => void, end: () => void): () => void {
    const generation = this.generation;
    this.checkCurrent(generation);
    const connection = http.createHttp();
    const decoder = util.TextDecoder.create('utf-8');
    let pending = '';
    let cancelled = false;
    connection.on('dataReceive', (chunk: ArrayBuffer) => {
      if (cancelled || generation !== this.generation || !this.active) return;
      pending += decoder.decodeWithStream(new Uint8Array(chunk), { stream: true });
      pending = pending.replace(/\r\n/g, '\n');
      let boundary = pending.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        let event = 'message'; const data: string[] = [];
        frame.split('\n').forEach((line: string) => {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        });
        if (data.length) receive(event, data.join('\n'));
        boundary = pending.indexOf('\n\n');
      }
    });
    const finish = (): void => { if (!cancelled) { cancelled = true; connection.destroy(); end(); } };
    connection.on('dataEnd', finish);
    connection.requestInStream(this.endpoint + path, { method: http.RequestMethod.GET,
      header: { 'Cookie': this.cookie, 'Accept': 'text/event-stream' }, usingCache: false,
      connectTimeout: 15000, readTimeout: 60000
    }).then((status: number) => { this.checkAuthentication(status, generation, path); if (status !== 200) finish(); }).catch(finish);
    return (): void => { if (!cancelled) { cancelled = true; connection.destroy(); } };
  }

  async binary(path: string): Promise<ArrayBuffer> {
    if (!this.endpoint || !path.startsWith('/api/')) throw new Error('Invalid file URL.');
    const generation = this.generation;
    this.checkCurrent(generation);
    const connection = http.createHttp();
    try {
      const response = await connection.request(this.endpoint + path, {
        method: http.RequestMethod.GET, header: { 'Cookie': this.cookie },
        expectDataType: http.HttpDataType.ARRAY_BUFFER, usingCache: false,
        connectTimeout: 15000, readTimeout: 60000
      });
      this.checkAuthentication(response.responseCode, generation, path);
      if (response.responseCode !== 200) throw new ApiError(response.responseCode, 'File download failed (' + response.responseCode + ')', '');
      return response.result as ArrayBuffer;
    } finally { connection.destroy(); }
  }

  async request(path: string, method: http.RequestMethod = http.RequestMethod.GET,
    body?: string): Promise<string> {
    if (!this.endpoint || !path.startsWith('/api/')) {
      throw new Error('A server address and API path are required.');
    }
    const generation = this.generation;
    this.checkCurrent(generation);
    const connection = http.createHttp();
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (this.cookie) {
      headers['Cookie'] = this.cookie;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    try {
      const response = await connection.request(this.endpoint + path, {
        method: method,
        header: headers,
        extraData: body,
        expectDataType: http.HttpDataType.STRING,
        usingCache: false,
        connectTimeout: 15000,
        readTimeout: 60000
      });
      this.checkAuthentication(response.responseCode, generation, path);
      const text = response.result as string;
      if (response.responseCode < 200 || response.responseCode >= 300) {
        let message = 'Request failed (' + response.responseCode + ')';
        try {
          const data = JSON.parse(text) as ErrorResponse;
          message = data.error || message;
        } catch (_) {
          // Proxy errors need not contain JSON; preserve the HTTP status.
        }
        throw new ApiError(response.responseCode, message, text);
      }
      const responseHeaders = response.header as Record<string, string | string[]>;
      let cookieText = response.cookies || '';
      Object.keys(responseHeaders).forEach((key: string) => {
        if (key.toLowerCase() === 'set-cookie') {
          const value = responseHeaders[key];
          cookieText += '; ' + (typeof value === 'string' ? value : value.join('; '));
        }
      });
      const match = cookieText.match(/\b(codoxear_auth=[^;,\s]+)/);
      if (match) {
        this.cookie = match[1];
      }
      return text;
    } finally {
      connection.destroy();
    }
  }
}
