import { notarize } from '@electron/notarize';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function hasSignature(appPath) {
  try {
    await execFileAsync('codesign', ['--verify', '--deep', '--strict', appPath]);
    return true;
  } catch {
    return false;
  }
}

async function adHocSign(appPath) {
  await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
}

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  const appleId = process.env.APPLE_ID || process.env.APPLEID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLEIDPASS;
  const teamId = process.env.APPLE_TEAM_ID;

  const signed = await hasSignature(appPath);
  if (!signed) {
    console.log('[metapi-desktop] No macOS signing identity detected, applying ad-hoc signature.');
    await adHocSign(appPath);
  }

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[metapi-desktop] Skipping notarization: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not fully configured.');
    return;
  }

  console.log('[metapi-desktop] Notarizing macOS build...');
  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
}
