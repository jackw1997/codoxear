import { cryptoFramework } from '@kit.CryptoArchitectureKit';
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

export interface RelayConnection {
  endpoint: string;
  issuer: string;
  accountId: string;
  hubId: string;
  computerId: string;
  accessToken: string;
  tokenProvider?: () => Promise<string>;
}

interface LoginRequest {
  password: string;
}

// Cookies are scoped to this client/endpoint. SavedLogin owns OS credential storage.
// Mutation calls are deliberately never retried: a lost send response may have
// committed a prompt to the PTY, so repeating it would duplicate the user's turn.
export class ApiClient {
  private endpoint: string = '';
  private cookie: string = '';
  private relay: RelayConnection | undefined = undefined;
  private generation: number = 0;
  private active: boolean = false;
  private connections: http.HttpRequest[] = [];
  onUnauthorized: () => void = () => {};

  invalidate(): void { this.generation++; this.cookie = ''; this.relay = undefined; this.active = false; const connections = this.connections; this.connections = []; for (const connection of connections) connection.destroy(); }
  private openConnection(): http.HttpRequest { const connection = http.createHttp(); this.connections.push(connection); return connection; }
  private closeConnection(connection: http.HttpRequest): void { this.connections = this.connections.filter((item: http.HttpRequest) => item !== connection); connection.destroy(); }
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
    if (this.endpoint !== value || this.relay !== undefined) {
      this.invalidate();
    }
    this.endpoint = value; this.active = true;
  }

  configureRelay(connection: RelayConnection): void {
    if (!/^https:\/\/[^\s/?#@]+$/.test(connection.endpoint) || !/^https:\/\/[^\s/?#@]+$/.test(connection.issuer)) {
      throw new Error('Relay connections require exact HTTPS hub and identity origins.');
    }
    for (const value of [connection.accountId, connection.hubId, connection.computerId]) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error('Invalid relay context.');
    }
    if (!connection.accessToken) throw new Error('A hub-specific access token is required.');
    this.invalidate(); this.endpoint = connection.endpoint;
    this.relay = { endpoint: connection.endpoint, issuer: connection.issuer, accountId: connection.accountId,
      hubId: connection.hubId, computerId: connection.computerId, accessToken: connection.accessToken, tokenProvider: connection.tokenProvider };
    this.active = true;
  }

  recoveryScope(): string {
    const relay = this.relay;
    return relay === undefined ? this.endpoint : JSON.stringify(['relay-v1', relay.issuer, relay.accountId, relay.hubId, relay.computerId]);
  }
  notificationScope(): string {
    return this.relay === undefined ? this.address('/api/me') : this.recoveryScope();
  }
  async recoveryFileScope(): Promise<string> {
    // Preserve direct-mode filenames. Relay context can exceed a filesystem's
    // component limit, so use a stable SHA-256 name for its complete scope.
    if (this.relay === undefined) return encodeURIComponent(this.endpoint);
    const digest = cryptoFramework.createMd('SHA256');
    await digest.update({ data: new util.TextEncoder().encodeInto(this.recoveryScope()) });
    const result = await digest.digest();
    return 'relay-v1-' + Array.from(result.data).map((value: number): string => value.toString(16).padStart(2, '0')).join('');
  }

  address(path: string): string {
    if (!path.startsWith('/api/') || /[\\\r\n\0]/.test(path)) throw new Error('Invalid media URL.');
    const decoded = decodeURIComponent(path.split('?')[0]);
    if (decoded.indexOf('%') >= 0 || decoded.indexOf('\\') >= 0 || decoded.split('/').some((part: string) => part === '.' || part === '..')) throw new Error('Invalid media URL.');
    const relay = this.relay;
    return this.endpoint + (relay === undefined ? '' : '/api/v1/computers/' + relay.computerId) + path;
  }
  authHeaders(): Record<string, string> {
    const relay = this.relay;
    return relay === undefined ? { 'Cookie': this.cookie } : { 'Authorization': 'Bearer ' + relay.accessToken };
  }
  private async refreshAuthorization(generation: number): Promise<void> {
    const relay = this.relay;
    if (relay?.tokenProvider) {
      const token = await relay.tokenProvider(); this.checkCurrent(generation);
      if (this.relay !== relay || !token) throw new ApiError(401, 'Choose this Hub account again.', '');
      relay.accessToken = token;
    }
  }

  async login(password: string): Promise<void> {
    if (this.relay !== undefined) throw new Error("Use the identity login flow for this hub.");
    this.generation++; this.cookie = '';
    const body: LoginRequest = { password: password };
    await this.request('/api/login', http.RequestMethod.POST, JSON.stringify(body));
  }

  async logout(): Promise<void> {
    if (this.relay !== undefined) { this.invalidate(); return; }
    const generation = this.generation;
    try {
      await this.request('/api/logout', http.RequestMethod.POST, '{}');
    } finally {
      if (generation === this.generation) this.invalidate();
    }
  }

  private streamHeaders(): Record<string, string> {
    const headers = this.authHeaders(); headers['Accept'] = 'text/event-stream'; return headers;
  }

  stream(path: string, receive: (event: string, data: string) => void, end: () => void): () => void {
    const generation = this.generation;
    this.checkCurrent(generation);
    const connection = this.openConnection();
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
    const finish = (): void => { if (!cancelled) { cancelled = true; this.closeConnection(connection); if (generation === this.generation && this.active) end(); } };
    connection.on('dataEnd', finish);
    this.refreshAuthorization(generation).then(() => { if (cancelled) return 0; return connection.requestInStream(this.address(path), { method: http.RequestMethod.GET,
      header: this.streamHeaders(), usingCache: false,
      connectTimeout: 15000, readTimeout: 60000
    }); }).then((status: number) => { if (cancelled) return; this.checkAuthentication(status, generation, path); if (status !== 200) finish(); }).catch(finish);
    return (): void => { if (!cancelled) { cancelled = true; this.closeConnection(connection); } };
  }

  async binary(path: string): Promise<ArrayBuffer> {
    if (!this.endpoint || !path.startsWith('/api/')) throw new Error('Invalid file URL.');
    const generation = this.generation;
    this.checkCurrent(generation);
    await this.refreshAuthorization(generation);
    const connection = this.openConnection();
    try {
      const response = await connection.request(this.address(path), {
        method: http.RequestMethod.GET, header: this.authHeaders(),
        expectDataType: http.HttpDataType.ARRAY_BUFFER, usingCache: false,
        connectTimeout: 15000, readTimeout: 60000
      });
      this.checkAuthentication(response.responseCode, generation, path);
      if (response.responseCode !== 200) throw new ApiError(response.responseCode, 'File download failed (' + response.responseCode + ')', '');
      return response.result as ArrayBuffer;
    } finally { this.closeConnection(connection); }
  }

  async request(path: string, method: http.RequestMethod = http.RequestMethod.GET,
    body?: string): Promise<string> {
    if (!this.endpoint || !path.startsWith('/api/')) {
      throw new Error('A server address and API path are required.');
    }
    const generation = this.generation;
    this.checkCurrent(generation);
    await this.refreshAuthorization(generation);
    const connection = this.openConnection();
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    const authentication = this.authHeaders();
    Object.keys(authentication).forEach((key: string) => { headers[key] = authentication[key]; });
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    try {
      const response = await connection.request(this.address(path), {
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
      if (match && this.relay === undefined) {
        this.cookie = match[1];
      }
      return text;
    } finally {
      this.closeConnection(connection);
    }
  }
}
