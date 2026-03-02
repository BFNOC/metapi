import { OneHubAdapter } from './oneHub.js';
import type { CheckinResult } from './base.js';

export class DoneHubAdapter extends OneHubAdapter {
  readonly platformName: string = 'done-hub';

  async detect(url: string): Promise<boolean> {
    const normalized = url.toLowerCase();
    return normalized.includes('donehub') || normalized.includes('done-hub');
  }

  // DoneHub deployments generally do not expose /api/user/checkin.
  // Mark as unsupported so higher-level logic records it as skipped instead of failed.
  override async checkin(_baseUrl: string, _accessToken: string): Promise<CheckinResult> {
    return { success: false, message: 'checkin endpoint not found' };
  }

  // getModels is inherited from OneHubAdapter which already has /api/available_model fallback.
  // No need to override here — OneHub's implementation handles this correctly.
}
