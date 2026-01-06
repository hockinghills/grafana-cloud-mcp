/**
 * Grafana OAuth Handler
 * Handles OAuth authentication flow for Claude web integration
 */

import type {
  AuthRequest,
  OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import {
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from './workers-oauth-utils';

// Props stored in the OAuth token, available as this.props in MCP handlers
export type GrafanaProps = {
  grafanaUrl: string;
  grafanaToken: string;
  userId: string;
};

interface GrafanaEnv {
  OAUTH_KV: KVNamespace;
  COOKIE_ENCRYPTION_KEY: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

const app = new Hono<{ Bindings: GrafanaEnv }>();

/**
 * GET /authorize - Show the login form
 */
app.get('/authorize', async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;

  if (!clientId) {
    return c.text('Invalid request: missing client_id', 400);
  }

  // Generate CSRF protection
  const { token: csrfToken, setCookie } = generateCSRFProtection();

  return renderApprovalDialog({
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    serverName: 'Grafana Cloud MCP',
    serverDescription: 'Connect Claude to your Grafana Cloud instance',
    state: { oauthReqInfo },
    setCookie,
  });
});

/**
 * POST /authorize - Handle form submission and validate Grafana credentials
 */
app.post('/authorize', async (c) => {
  try {
    const formData = await c.req.raw.formData();

    // Validate CSRF token
    validateCSRFToken(formData, c.req.raw);

    // Extract state
    const encodedState = formData.get('state');
    if (!encodedState || typeof encodedState !== 'string') {
      throw new OAuthError('invalid_request', 'Missing state');
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      throw new OAuthError('invalid_request', 'Invalid state data');
    }

    if (!state.oauthReqInfo?.clientId) {
      throw new OAuthError('invalid_request', 'Invalid OAuth request');
    }

    // Get Grafana credentials from form
    const grafanaUrl = formData.get('grafana_url') as string;
    const grafanaToken = formData.get('grafana_token') as string;

    if (!grafanaUrl || !grafanaToken) {
      // Re-render form with error
      const { token: csrfToken, setCookie } = generateCSRFProtection();
      return renderApprovalDialog({
        client: await c.env.OAUTH_PROVIDER.lookupClient(
          state.oauthReqInfo.clientId,
        ),
        csrfToken,
        serverName: 'Grafana Cloud MCP',
        serverDescription: 'Connect Claude to your Grafana Cloud instance',
        state: { oauthReqInfo: state.oauthReqInfo },
        setCookie,
        errorMessage: 'Please enter both Grafana URL and token',
      });
    }

    // Validate Grafana credentials by calling their API
    const normalizedUrl = grafanaUrl.replace(/\/$/, '');
    const validationResult = await validateGrafanaCredentials(
      normalizedUrl,
      grafanaToken,
    );

    if (!validationResult.valid) {
      // Re-render form with error
      const { token: csrfToken, setCookie } = generateCSRFProtection();
      return renderApprovalDialog({
        client: await c.env.OAUTH_PROVIDER.lookupClient(
          state.oauthReqInfo.clientId,
        ),
        csrfToken,
        serverName: 'Grafana Cloud MCP',
        serverDescription: 'Connect Claude to your Grafana Cloud instance',
        state: { oauthReqInfo: state.oauthReqInfo },
        setCookie,
        errorMessage: validationResult.error || 'Invalid Grafana credentials',
      });
    }

    // Credentials are valid - create OAuth state and redirect to callback
    const { stateToken } = await createOAuthState(
      state.oauthReqInfo,
      c.env.OAUTH_KV,
    );
    const { setCookie: sessionCookie } = bindStateToSession(stateToken);

    // Store credentials temporarily in KV for the callback
    await c.env.OAUTH_KV.put(
      `grafana_creds:${stateToken}`,
      JSON.stringify({
        grafanaUrl: normalizedUrl,
        grafanaToken,
        userId: validationResult.userId,
        userName: validationResult.userName,
      }),
      { expirationTtl: 600 },
    );

    // Redirect to our callback endpoint
    const callbackUrl = new URL('/callback', c.req.url);
    callbackUrl.searchParams.set('state', stateToken);

    return new Response(null, {
      status: 302,
      headers: {
        Location: callbackUrl.href,
        'Set-Cookie': sessionCookie,
      },
    });
  } catch (error) {
    console.error('POST /authorize error:', error);
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return c.text(`Internal server error: ${(error as Error).message}`, 500);
  }
});

/**
 * GET /callback - Complete the OAuth flow
 */
app.get('/callback', async (c) => {
  try {
    // Validate OAuth state
    const { oauthReqInfo, clearCookie } = await validateOAuthState(
      c.req.raw,
      c.env.OAUTH_KV,
    );

    if (!oauthReqInfo.clientId) {
      throw new OAuthError('invalid_request', 'Invalid OAuth request data');
    }

    // Get the state token from URL
    const url = new URL(c.req.url);
    const stateToken = url.searchParams.get('state');

    if (!stateToken) {
      throw new OAuthError('invalid_request', 'Missing state');
    }

    // Retrieve stored Grafana credentials
    const storedCreds = await c.env.OAUTH_KV.get(`grafana_creds:${stateToken}`);
    if (!storedCreds) {
      throw new OAuthError('invalid_request', 'Credentials expired');
    }

    // Clean up
    await c.env.OAUTH_KV.delete(`grafana_creds:${stateToken}`);

    const { grafanaUrl, grafanaToken, userId, userName } =
      JSON.parse(storedCreds);

    // Complete the OAuth flow - issue token back to Claude
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      metadata: {
        label: userName || `Grafana User ${userId}`,
      },
      // These props will be available as this.props in the MCP handler
      props: {
        grafanaUrl,
        grafanaToken,
        userId,
      } as GrafanaProps,
      request: oauthReqInfo,
      scope: oauthReqInfo.scope,
      userId: String(userId),
    });

    // Clear session cookie and redirect
    const headers = new Headers({ Location: redirectTo });
    if (clearCookie) {
      headers.set('Set-Cookie', clearCookie);
    }

    return new Response(null, {
      status: 302,
      headers,
    });
  } catch (error) {
    console.error('GET /callback error:', error);
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return c.text('Internal server error', 500);
  }
});

/**
 * Validates Grafana credentials by calling the API
 */
async function validateGrafanaCredentials(
  baseUrl: string,
  token: string,
): Promise<{
  valid: boolean;
  error?: string;
  userId?: number;
  userName?: string;
}> {
  try {
    const response = await fetch(`${baseUrl}/api/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return {
          valid: false,
          error: 'Invalid token - check your service account token',
        };
      }
      if (response.status === 403) {
        return { valid: false, error: 'Token lacks required permissions' };
      }
      return {
        valid: false,
        error: `Grafana returned ${response.status}: ${response.statusText}`,
      };
    }

    const user = (await response.json()) as {
      id: number;
      login: string;
      name?: string;
    };
    return {
      valid: true,
      userId: user.id,
      userName: user.name || user.login,
    };
  } catch (error) {
    console.error('Grafana validation error:', error);
    return {
      valid: false,
      error: 'Could not connect to Grafana - check your URL',
    };
  }
}

export { app as GrafanaOAuthHandler };
