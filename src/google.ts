/** Google service-account auth — yields bearer tokens for GA4 and Sheets APIs. */

import { GoogleAuth } from 'google-auth-library';
import { googleCredentials } from './config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];

let auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (!auth) auth = new GoogleAuth({ ...googleCredentials(), scopes: SCOPES });
  return auth;
}

/** Fresh OAuth bearer token for the service account. */
export async function accessToken(): Promise<string> {
  const client = await getAuth().getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error('Failed to obtain Google access token');
  return token.token;
}
