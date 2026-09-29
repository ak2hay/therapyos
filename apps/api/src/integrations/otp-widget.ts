export const MSG91_WIDGET_VERIFY_URL = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';

export interface OtpWidgetCredentials {
  widgetId: string;
  tokenAuth: string;
  authKey: string;
  smsEnabled: boolean;
  emailEnabled: boolean;
}

/** What the browser or app needs to start the MSG91 OTP Widget; never includes the auth key. */
export interface OtpWidgetPublicConfig {
  enabled: boolean;
  widgetId?: string;
  tokenAuth?: string;
  channels?: { sms: boolean; email: boolean };
}

export type WidgetVerifyResult = { ok: true; identifier: string } | { ok: false; error: string; authFailure: boolean };

/** MSG91 OTP Widget server side: confirms the access token the widget returns after a successful OTP. */
export class Msg91OtpWidget {
  constructor(private readonly creds: OtpWidgetCredentials) {}

  publicConfig(): OtpWidgetPublicConfig {
    return { enabled: true, widgetId: this.creds.widgetId, tokenAuth: this.creds.tokenAuth, channels: { sms: this.creds.smsEnabled, email: this.creds.emailEnabled } };
  }

  /** MSG91 answers HTTP 200 even for failures, so only `type: success` counts. */
  async verifyAccessToken(accessToken: string): Promise<WidgetVerifyResult> {
    try {
      const res = await fetch(MSG91_WIDGET_VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ authkey: this.creds.authKey, 'access-token': accessToken }),
      });
      const json = (await res.json().catch(() => ({}))) as { type?: string; message?: string; code?: string | number };
      if (res.ok && json.type === 'success' && json.message) return { ok: true, identifier: String(json.message) };
      const error = json.message ?? `HTTP ${res.status}`;
      return { ok: false, error, authFailure: /authenticat|auth ?key|\bip\b|whitelist/i.test(error) };
    } catch (e) {
      return { ok: false, error: (e as Error).message, authFailure: false };
    }
  }
}
