import type { PlatformAdapter } from './base.js';
import { AnyRouterAdapter } from './anyrouter.js';
import { NewApiAdapter } from './newApi.js';
import { OneApiAdapter } from './oneApi.js';
import { VeloeraAdapter } from './veloera.js';
import { OneHubAdapter } from './oneHub.js';
import { DoneHubAdapter } from './doneHub.js';
import { Sub2ApiAdapter } from './sub2api.js';
import { OpenAiAdapter } from './openai.js';
import { ClaudeAdapter } from './claude.js';
import { GeminiAdapter } from './gemini.js';
import { CliProxyApiAdapter } from './cliproxyapi.js';
import { detectPlatformByTitle } from './titleHint.js';

const adapters: PlatformAdapter[] = [
  // Specific forks before generic adapters for better auto-detection.
  new OpenAiAdapter(),
  new ClaudeAdapter(),
  new GeminiAdapter(),
  new CliProxyApiAdapter(),
  new AnyRouterAdapter(),
  new DoneHubAdapter(),
  new OneHubAdapter(),
  new VeloeraAdapter(),
  new NewApiAdapter(),
  new Sub2ApiAdapter(),
  new OneApiAdapter(),
];

const platformAliases: Record<string, string> = {
  // NewAPI family aliases
  anyrouter: 'anyrouter',
  'wong-gongyi': 'new-api',
  'vo-api': 'new-api',
  'super-api': 'new-api',
  'rix-api': 'new-api',
  'neo-api': 'new-api',
  newapi: 'new-api',
  'new api': 'new-api',
  // OneAPI family aliases
  oneapi: 'one-api',
  'one api': 'one-api',
  // Keep canonical forms explicit for clarity
  'new-api': 'new-api',
  'one-api': 'one-api',
  veloera: 'veloera',
  'one-hub': 'one-hub',
  'done-hub': 'done-hub',
  sub2api: 'sub2api',
  // Official upstream APIs
  openai: 'openai',
  anthropic: 'claude',
  claude: 'claude',
  gemini: 'gemini',
  google: 'gemini',
  // CLIProxyAPI aliases
  cliproxyapi: 'cliproxyapi',
  cpa: 'cliproxyapi',
  'cli-proxy-api': 'cliproxyapi',
};

function normalizePlatform(platform: string): string {
  const raw = (platform || '').trim().toLowerCase();
  return platformAliases[raw] ?? raw;
}

export function getAdapter(platform: string): PlatformAdapter | undefined {
  const normalized = normalizePlatform(platform);
  return adapters.find((a) => a.platformName === normalized);
}

const titleFirstPlatforms = new Set<string>([
  'anyrouter',
  'done-hub',
  'one-hub',
  'veloera',
  'sub2api',
]);

export async function detectPlatform(url: string): Promise<PlatformAdapter | undefined> {
  const titleHint = await detectPlatformByTitle(url);
  if (titleHint && titleFirstPlatforms.has(titleHint)) {
    return getAdapter(titleHint);
  }

  for (const adapter of adapters) {
    if (await adapter.detect(url)) return adapter;
  }

  if (titleHint) {
    return getAdapter(titleHint);
  }

  return undefined;
}
