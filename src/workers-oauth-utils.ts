/**
 * OAuth utility functions for MCP server authentication
 * Based on Cloudflare's workers-oauth-provider patterns
 */

import type {
  AuthRequest,
  ClientInfo,
} from '@cloudflare/workers-oauth-provider';

/**
 * OAuth 2.1 compliant error class
 */
export class OAuthError extends Error {
  constructor(
    public code: string,
    public description: string,
    public statusCode = 400,
  ) {
    super(description);
    this.name = 'OAuthError';
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({
        error: this.code,
        error_description: this.description,
      }),
      {
        status: this.statusCode,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}

/**
 * Sanitizes text content for safe display in HTML
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generates a cryptographically secure random string
 */
export function generateSecureToken(length = 32): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * Generates CSRF protection token and cookie
 */
export function generateCSRFProtection(): {
  token: string;
  setCookie: string;
} {
  const token = generateSecureToken(32);
  const setCookie = `__Host-CSRF=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`;
  return { token, setCookie };
}

/**
 * Validates CSRF token from form submission
 */
export function validateCSRFToken(
  formData: FormData,
  request: Request,
): { clearCookie: string } {
  const formToken = formData.get('csrf_token');
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [key, ...val] = c.trim().split('=');
      return [key, val.join('=')];
    }),
  );
  const cookieToken = cookies['__Host-CSRF'];

  if (!formToken || !cookieToken || formToken !== cookieToken) {
    throw new OAuthError('invalid_request', 'Invalid CSRF token', 403);
  }

  return {
    clearCookie:
      '__Host-CSRF=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0',
  };
}

/**
 * Creates OAuth state and stores it in KV
 */
export async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace,
): Promise<{ stateToken: string }> {
  const stateToken = generateSecureToken(32);

  await kv.put(
    `oauth_state:${stateToken}`,
    JSON.stringify({
      oauthReqInfo,
      createdAt: Date.now(),
    }),
    { expirationTtl: 600 }, // 10 minutes
  );

  return { stateToken };
}

/**
 * Validates OAuth state from KV and request
 */
export async function validateOAuthState(
  request: Request,
  kv: KVNamespace,
): Promise<{ oauthReqInfo: AuthRequest; clearCookie: string }> {
  const url = new URL(request.url);
  const stateToken = url.searchParams.get('state');

  if (!stateToken) {
    throw new OAuthError('invalid_request', 'Missing state parameter');
  }

  // Validate state cookie binding
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [key, ...val] = c.trim().split('=');
      return [key, val.join('=')];
    }),
  );
  const sessionState = cookies['__Host-OAUTH_STATE'];

  if (!sessionState || sessionState !== stateToken) {
    throw new OAuthError(
      'invalid_request',
      'State mismatch - possible CSRF attack',
      403,
    );
  }

  // Retrieve and validate from KV
  const stored = await kv.get(`oauth_state:${stateToken}`);
  if (!stored) {
    throw new OAuthError('invalid_request', 'Invalid or expired state');
  }

  // Delete state (one-time use)
  await kv.delete(`oauth_state:${stateToken}`);

  const { oauthReqInfo } = JSON.parse(stored);

  return {
    oauthReqInfo,
    clearCookie:
      '__Host-OAUTH_STATE=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
  };
}

/**
 * Binds OAuth state to session cookie
 */
export function bindStateToSession(stateToken: string): { setCookie: string } {
  return {
    setCookie: `__Host-OAUTH_STATE=${stateToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
  };
}

/**
 * Renders the OAuth approval/login dialog
 */
export function renderApprovalDialog(options: {
  client: ClientInfo | null;
  csrfToken: string;
  serverName: string;
  serverDescription: string;
  state: { oauthReqInfo: AuthRequest };
  setCookie: string;
  errorMessage?: string;
}): Response {
  const {
    client,
    csrfToken,
    serverName,
    serverDescription,
    state,
    setCookie,
    errorMessage,
  } = options;
  const clientName = client?.clientName || 'Unknown Client';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect to ${sanitizeText(serverName)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 420px;
      width: 100%;
      padding: 40px;
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo {
      width: 64px;
      height: 64px;
      background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
      border-radius: 16px;
      margin: 0 auto 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
    }
    h1 {
      font-size: 24px;
      color: #1a1a2e;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #64748b;
      font-size: 14px;
    }
    .client-info {
      background: #f8fafc;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }
    .client-name {
      font-weight: 600;
      color: #1a1a2e;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      color: #374151;
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e5e7eb;
      border-radius: 8px;
      font-size: 16px;
      transition: border-color 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #f97316;
    }
    .hint {
      font-size: 12px;
      color: #64748b;
      margin-top: 4px;
    }
    .error {
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #dc2626;
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(249, 115, 22, 0.4);
    }
    .footer {
      text-align: center;
      margin-top: 24px;
      font-size: 12px;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">📊</div>
      <h1>${sanitizeText(serverName)}</h1>
      <p class="subtitle">${sanitizeText(serverDescription)}</p>
    </div>

    <div class="client-info">
      <span class="client-name">${sanitizeText(clientName)}</span> wants to connect
    </div>

    ${errorMessage ? `<div class="error">${sanitizeText(errorMessage)}</div>` : ''}

    <form method="POST" action="/authorize">
      <input type="hidden" name="csrf_token" value="${csrfToken}">
      <input type="hidden" name="state" value="${btoa(JSON.stringify(state))}">

      <div class="form-group">
        <label for="grafana_url">Grafana Cloud URL</label>
        <input type="url" id="grafana_url" name="grafana_url"
               placeholder="https://your-org.grafana.net" required>
        <p class="hint">Your Grafana Cloud instance URL</p>
      </div>

      <div class="form-group">
        <label for="grafana_token">Service Account Token</label>
        <input type="password" id="grafana_token" name="grafana_token"
               placeholder="glsa_..." required>
        <p class="hint">Create one at Grafana → Administration → Service Accounts</p>
      </div>

      <button type="submit">Connect to Grafana</button>
    </form>

    <p class="footer">Your credentials are encrypted and stored securely</p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': setCookie,
    },
  });
}
